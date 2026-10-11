// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {IWrappedNative, IPancakeV3PoolMin} from "./RaceBuilderPcs.sol";

interface IRaceBuilderPcsPools {
    function vault() external view returns (IVault);
    function poolManager() external view returns (ICLPoolManager);
    function usdc() external view returns (IERC20);
    function wbnb() external view returns (IWrappedNative);
    function dollarPool() external view returns (IPancakeV3PoolMin);
    function poolKeyFor(address coin) external view returns (PoolKey memory);
}

/**
 * @title RaceTradePcs (sasa v7): buy and sell a coin with USDC on BNB Chain
 * @notice The coin's pool is coin/BNB on PancakeSwap Infinity, but sasa users only see
 * dollars. One call does USDC -> BNB (PancakeSwap v3 USDC/WBNB, the same dollar pool the
 * builder uses) -> coin, or the way back. The user's own minimum protects the whole trade.
 * This contract never holds anything between calls and has no owner.
 */
contract RaceTradePcs is ILockCallback {
    using SafeERC20 for IERC20;

    uint160 internal constant V3_MIN_SQRT = 4295128739 + 1;
    uint160 internal constant V3_MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;
    Currency internal constant BNB = Currency.wrap(address(0));

    IRaceBuilderPcsPools public immutable builder;
    IVault public immutable vault;
    ICLPoolManager public immutable poolManager;
    IERC20 public immutable usdc;
    IWrappedNative public immutable wbnb;
    IPancakeV3PoolMin public immutable dollarPool;
    bool internal immutable usdcIsToken0;

    uint8 private _step; // 0 idle, 1 in a trade, 2 inside the v3 swap

    event Bought(address indexed coin, address indexed buyer, uint256 usdcIn, uint256 coinsOut);
    event Sold(address indexed coin, address indexed seller, uint256 coinsIn, uint256 usdcOut);

    error Expired();
    error NothingToDo();
    error Busy();
    error NotOurCall();
    error Slippage(uint256 got, uint256 minimum);

    constructor(IRaceBuilderPcsPools builder_) {
        builder = builder_;
        vault = builder_.vault();
        poolManager = builder_.poolManager();
        usdc = builder_.usdc();
        wbnb = builder_.wbnb();
        dollarPool = builder_.dollarPool();
        usdcIsToken0 = dollarPool.token0() == address(usdc);
    }

    receive() external payable {
        if (msg.sender != address(vault) && msg.sender != address(wbnb)) revert NotOurCall();
    }

    /// @notice Spends `usdcIn` of the caller's USDC (approve this contract first) on `coin`.
    function buy(address coin, uint256 usdcIn, uint256 minCoinsOut, address to, uint256 deadline)
        external
        returns (uint256 coinsOut)
    {
        _enter(usdcIn, to, deadline);
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        uint256 w0 = IERC20(address(wbnb)).balanceOf(address(this));
        _v3(usdcIsToken0, usdcIn);
        uint256 bnb = IERC20(address(wbnb)).balanceOf(address(this)) - w0;
        wbnb.withdraw(bnb);
        coinsOut = abi.decode(vault.lock(abi.encode(true, msg.sender, coin, bnb, to)), (uint256));
        _step = 0;
        if (coinsOut < minCoinsOut) revert Slippage(coinsOut, minCoinsOut);
        emit Bought(coin, msg.sender, usdcIn, coinsOut);
    }

    /// @notice Sells `coinsIn` of the caller's `coin` (approve this contract first) for USDC.
    function sell(address coin, uint256 coinsIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut)
    {
        _enter(coinsIn, to, deadline);
        uint256 bnb = abi.decode(vault.lock(abi.encode(false, msg.sender, coin, coinsIn, address(this))), (uint256));
        wbnb.deposit{value: bnb}();
        uint256 u0 = usdc.balanceOf(address(this));
        _v3(!usdcIsToken0, bnb);
        usdcOut = usdc.balanceOf(address(this)) - u0;
        _step = 0;
        if (usdcOut < minUsdcOut) revert Slippage(usdcOut, minUsdcOut);
        usdc.safeTransfer(to, usdcOut);
        emit Sold(coin, msg.sender, coinsIn, usdcOut);
    }

    function _enter(uint256 amountIn, address to, uint256 deadline) private {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || to == address(0)) revert NothingToDo();
        if (_step != 0) revert Busy();
        _step = 1;
    }

    /// @dev buy: BNB -> coin, coins to `to`. sell: coin (paid by the user) -> BNB, BNB here.
    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(vault) || _step != 1) revert NotOurCall();
        (bool isBuy, address payer, address coin, uint256 amountIn, address to) =
            abi.decode(data, (bool, address, address, uint256, address));
        PoolKey memory key = builder.poolKeyFor(coin);
        BalanceDelta d = poolManager.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            bytes("")
        );
        int128 o = isBuy ? d.amount1() : d.amount0();
        uint256 out = o > 0 ? uint256(uint128(o)) : 0;
        // what this contract owes
        int256 bnbDelta = vault.currencyDelta(address(this), BNB);
        if (bnbDelta < 0) vault.settle{value: uint256(-bnbDelta)}();
        int256 coinDelta = vault.currencyDelta(address(this), key.currency1);
        if (coinDelta < 0) {
            vault.sync(key.currency1);
            IERC20(coin).safeTransferFrom(payer, address(vault), uint256(-coinDelta));
            vault.settle();
        }
        // what it is owed
        if (coinDelta > 0) vault.take(key.currency1, to, uint256(coinDelta));
        if (bnbDelta > 0) vault.take(BNB, isBuy ? to : address(this), uint256(bnbDelta));
        return abi.encode(out);
    }

    function _v3(bool zeroForOne, uint256 amountIn) private {
        _step = 2;
        dollarPool.swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? V3_MIN_SQRT : V3_MAX_SQRT, bytes(""));
        _step = 1;
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(dollarPool) || _step != 2) revert NotOurCall();
        if (amount0Delta > 0) {
            IERC20(usdcIsToken0 ? address(usdc) : address(wbnb)).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(usdcIsToken0 ? address(wbnb) : address(usdc)).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }
}
