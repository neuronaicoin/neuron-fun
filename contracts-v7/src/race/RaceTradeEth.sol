// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";

interface IRaceBuilderEthPools {
    function poolManager() external view returns (IPoolManager);
    function usdc() external view returns (IERC20);
    function poolKeyFor(address coin) external view returns (PoolKey memory);
    function dollarPoolKey() external view returns (PoolKey memory);
}

/**
 * @title RaceTradeEth (sasa v7): buy and sell a coin with USDC on Base / Robinhood Chain
 * @notice The coin's pool is coin/ETH, but sasa users only see dollars. One call does
 * USDC -> ETH (the chain's deep ETH/dollar Uniswap pool) -> coin, or the way back, inside a
 * single Uniswap unlock: the ETH in the middle never leaves Uniswap. The user's own minimum
 * protects the whole trade. This contract never holds anything between calls and has no owner.
 */
contract RaceTradeEth is IUnlockCallback {
    using SafeERC20 for IERC20;
    using TransientStateLibrary for IPoolManager;

    IRaceBuilderEthPools public immutable builder;
    IPoolManager public immutable poolManager;
    IERC20 public immutable usdc;
    Currency internal constant ETH = Currency.wrap(address(0));

    bool private _busy;

    event Bought(address indexed coin, address indexed buyer, uint256 usdcIn, uint256 coinsOut);
    event Sold(address indexed coin, address indexed seller, uint256 coinsIn, uint256 usdcOut);

    error Expired();
    error NothingToDo();
    error Busy();
    error OnlyPoolManager();
    error Slippage(uint256 got, uint256 minimum);

    constructor(IRaceBuilderEthPools builder_) {
        builder = builder_;
        poolManager = builder_.poolManager();
        usdc = builder_.usdc();
    }

    /// @notice Spends `usdcIn` of the caller's USDC (approve this contract first) on `coin`.
    function buy(address coin, uint256 usdcIn, uint256 minCoinsOut, address to, uint256 deadline)
        external
        returns (uint256 coinsOut)
    {
        coinsOut = _trade(true, coin, usdcIn, minCoinsOut, to, deadline);
        emit Bought(coin, msg.sender, usdcIn, coinsOut);
    }

    /// @notice Sells `coinsIn` of the caller's `coin` (approve this contract first) for USDC.
    function sell(address coin, uint256 coinsIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut)
    {
        usdcOut = _trade(false, coin, coinsIn, minUsdcOut, to, deadline);
        emit Sold(coin, msg.sender, coinsIn, usdcOut);
    }

    function _trade(bool isBuy, address coin, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        private
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || to == address(0)) revert NothingToDo();
        if (_busy) revert Busy();
        _busy = true;
        out = abi.decode(poolManager.unlock(abi.encode(isBuy, msg.sender, coin, amountIn, to)), (uint256));
        _busy = false;
        if (out < minOut) revert Slippage(out, minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (!_busy) revert Busy();
        (bool isBuy, address payer, address coin, uint256 amountIn, address to) =
            abi.decode(data, (bool, address, address, uint256, address));
        PoolKey memory coinKey = builder.poolKeyFor(coin);
        PoolKey memory dollarKey = builder.dollarPoolKey();
        bool usdcIs0 = Currency.unwrap(dollarKey.currency0) == address(usdc);
        uint256 out;
        Currency inC;
        Currency outC;
        if (isBuy) {
            uint256 eth = _exactIn(dollarKey, usdcIs0, amountIn); // USDC -> ETH
            out = _exactIn(coinKey, true, eth); // ETH -> coin (ETH is currency0)
            (inC, outC) = (Currency.wrap(address(usdc)), Currency.wrap(coin));
        } else {
            uint256 eth = _exactIn(coinKey, false, amountIn); // coin -> ETH
            out = _exactIn(dollarKey, !usdcIs0, eth); // ETH -> USDC
            (inC, outC) = (Currency.wrap(coin), Currency.wrap(address(usdc)));
        }
        // pay what is owed from the user, give what is owed to `to`; ETH nets to zero
        int256 owed = poolManager.currencyDelta(address(this), inC);
        if (owed < 0) {
            poolManager.sync(inC);
            IERC20(Currency.unwrap(inC)).safeTransferFrom(payer, address(poolManager), uint256(-owed));
            poolManager.settle();
        }
        int256 credit = poolManager.currencyDelta(address(this), outC);
        if (credit > 0) poolManager.take(outC, to, uint256(credit));
        int256 dust = poolManager.currencyDelta(address(this), ETH);
        if (dust > 0) poolManager.take(ETH, to, uint256(dust));
        return abi.encode(credit > 0 ? uint256(credit) : 0);
    }

    function _exactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) private returns (uint256 out) {
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );
        int128 o = zeroForOne ? d.amount1() : d.amount0();
        out = o > 0 ? uint256(uint128(o)) : 0;
    }
}
