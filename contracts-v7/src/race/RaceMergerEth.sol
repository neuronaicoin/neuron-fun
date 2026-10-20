// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

interface IBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title RaceMergerEth
 * @notice sasa v8: the merge for ETH-paired race coins (Base, Robinhood Chain), kept out of
 * RaceBuilderEth so the builder stays under the 24 KB contract size limit. The builder creates
 * it in its constructor and is the only caller.
 *
 * `merge` takes the ETH that arrived from the losing chains: half buys the coin in its own
 * pool (stopping at `capTick`, so the buy can at most double the race-end price), then the
 * coins bought and the other half are added together as one full-range position owned by the
 * builder (its fees are collected with the coin's other positions). Whatever ETH is left goes
 * back to the builder (it funds buybacks), coins left over are burned. It holds nothing
 * between calls.
 */
contract RaceMergerEth is IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    address public immutable builder;

    /// @notice How far the coin may have risen since the race ended before arriving money
    /// stops buying it (20%: then it funds buybacks instead, so nobody can pump the coin just
    /// before the money lands and sell into the merge buy), and how far the merge buy itself may
    /// push the price (2x the race-end price). 1 tick = 0.01%.
    int24 public constant MERGE_MAX_RISE_TICKS = 1823; // ~ +20%
    int24 public constant MERGE_CAP_TICKS = 6932; // ~ x2

    event MergeBuy(address indexed coin, uint256 ethSpent, uint256 coinsBought);

    error NotBuilder();
    error OnlyPoolManager();
    error Pumped();

    constructor(IPoolManager poolManager_, IPositionManager positionManager_, IAllowanceTransfer permit2_) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        builder = msg.sender;
    }

    /// @dev ETH comes from the builder (the merge) and the PositionManager (unused ETH swept back).
    receive() external payable {
        if (msg.sender != builder && msg.sender != address(positionManager)) revert NotBuilder();
    }

    /// @param endTick the coin pool's tick when the race ended
    /// @return positionId the new full-range position (0 when none could be made)
    function merge(PoolKey calldata key, int24 endTick) external payable returns (uint256 positionId) {
        if (msg.sender != builder) revert NotBuilder();
        address coin = Currency.unwrap(key.currency1); // ETH (address 0) is always currency0
        // ETH = currency0: the coin gets dearer as the tick FALLS
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        if (tick < endTick - MERGE_MAX_RISE_TICKS) revert Pumped();
        int24 capTick = endTick - MERGE_CAP_TICKS;
        if (capTick < TickMath.MIN_TICK + 1) capTick = TickMath.MIN_TICK + 1;
        (uint256 spent, uint256 coins) = abi.decode(poolManager.unlock(abi.encode(key, msg.value / 2, capTick)), (uint256, uint256));
        emit MergeBuy(coin, spent, coins);

        uint256 ethLeft = address(this).balance;
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        int24 lower = TickMath.minUsableTick(key.tickSpacing);
        int24 upper = TickMath.maxUsableTick(key.tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), ethLeft, coins
        );
        if (liquidity > 0) {
            IERC20(coin).forceApprove(address(permit2), type(uint256).max);
            permit2.approve(coin, address(positionManager), uint160(coins), uint48(block.timestamp));
            positionId = positionManager.nextTokenId();
            bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
            bytes[] memory params = new bytes[](3);
            params[0] = abi.encode(key, lower, upper, uint256(liquidity), ethLeft, coins, builder, bytes(""));
            params[1] = abi.encode(key.currency0, key.currency1);
            params[2] = abi.encode(key.currency0, address(this));
            positionManager.modifyLiquidities{value: ethLeft}(abi.encode(actions, params), block.timestamp);
            IERC20(coin).forceApprove(address(permit2), 0);
            permit2.approve(coin, address(positionManager), 0, uint48(block.timestamp));
        }
        uint256 coinsLeft = IERC20(coin).balanceOf(address(this));
        if (coinsLeft > 0) IBurnable(coin).burn(coinsLeft);
        uint256 back = address(this).balance;
        if (back > 0) {
            (bool ok,) = builder.call{value: back}("");
            require(ok);
        }
    }

    /// @dev The capped buy: ETH -> coin, the price stopping at `capTick`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (PoolKey memory key, uint256 amountIn, int24 capTick) = abi.decode(data, (PoolKey, uint256, int24));
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(capTick)}),
            bytes("")
        );
        uint256 spent = d.amount0() < 0 ? uint256(uint128(-d.amount0())) : 0;
        uint256 coins = d.amount1() > 0 ? uint256(uint128(d.amount1())) : 0;
        if (spent > 0) poolManager.settle{value: spent}();
        if (coins > 0) poolManager.take(key.currency1, address(this), coins);
        return abi.encode(spent, coins);
    }
}
