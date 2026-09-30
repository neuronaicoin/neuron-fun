// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IUsdGraduatedPools {
    function poolKeyFor(address token) external view returns (PoolKey memory);
    function positions(address token) external view returns (uint256 tokenId, address creator);
    function usdc() external view returns (IERC20);
    function usdcIsCurrency0(address token) external view returns (bool);
}

/**
 * @title UsdPoolRouter
 * @notice USD edition (v5) of NeuronPoolRouter: buys and sells graduated coins
 * for USDC in the locked coin/USDC pools the migrator created. Nothing else:
 * no owner, no extra fee (the pool already charges 1%), nothing kept.
 *
 * - Exact input; every trade has a minimum output and a deadline.
 * - Only what a trade actually spends is pulled from the payer (approve this
 *   contract first), so there is never a refund to send back.
 * - Each trade emits PoolTrade with the real trader (same event as v4; the
 *   "nativeAmount" field is the USDC amount here).
 */
contract UsdPoolRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IUsdGraduatedPools public immutable pools;
    IERC20 public immutable usdc;

    event PoolTrade(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96After
    );

    error NotPoolManager();
    error NotGraduated();
    error ZeroAmount();
    error Expired();
    error Slippage(uint256 got, uint256 min);
    error ZeroAddress();

    struct Job {
        bool isBuy;
        address token;
        uint256 amountIn;
        address payer;
        address recipient;
    }

    constructor(IPoolManager poolManager_, IUsdGraduatedPools pools_) {
        if (address(poolManager_) == address(0) || address(pools_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        pools = pools_;
        usdc = pools_.usdc();
    }

    /// @notice Spends up to `usdcIn` USDC on `token`. Coins go to `recipient`.
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (usdcIn == 0) revert ZeroAmount();
        tokensOut = _trade(Job(true, token, usdcIn, msg.sender, recipient), minTokensOut, deadline);
    }

    /// @notice Sells `amountIn` of `token` (approve this contract first). USDC goes to `recipient`.
    function sell(address token, uint256 amountIn, uint256 minUsdcOut, address recipient, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        usdcOut = _trade(Job(false, token, amountIn, msg.sender, recipient), minUsdcOut, deadline);
    }

    function _trade(Job memory job, uint256 minOut, uint256 deadline) private returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        if (job.recipient == address(0)) revert ZeroAddress();
        (uint256 tokenId,) = pools.positions(job.token);
        if (tokenId == 0) revert NotGraduated();
        (uint256 paid, uint256 got) = abi.decode(poolManager.unlock(abi.encode(job)), (uint256, uint256));
        out = got;
        if (out < minOut) revert Slippage(out, minOut);
        (uint160 sqrtP,,,) = poolManager.getSlot0(pools.poolKeyFor(job.token).toId());
        emit PoolTrade(job.token, job.payer, job.isBuy, job.isBuy ? paid : out, job.isBuy ? out : paid, sqrtP);
    }

    /// @dev Called by the PoolManager inside unlock(). Returns (amount paid, amount received).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Job memory job = abi.decode(data, (Job));
        PoolKey memory key = pools.poolKeyFor(job.token);
        bool u0 = pools.usdcIsCurrency0(job.token);
        // Paying in currency0 means swapping zero-for-one.
        bool zeroForOne = job.isBuy ? u0 : !u0;
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(job.amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        uint256 paid = uint256(uint128(zeroForOne ? -a0 : -a1));
        uint256 got = uint256(uint128(zeroForOne ? a1 : a0));
        Currency payIn = zeroForOne ? key.currency0 : key.currency1;
        Currency payOut = zeroForOne ? key.currency1 : key.currency0;

        // Pay exactly what the swap used, straight from the payer.
        poolManager.sync(payIn);
        IERC20(Currency.unwrap(payIn)).safeTransferFrom(job.payer, address(poolManager), paid);
        poolManager.settle();
        poolManager.take(payOut, job.recipient, got);
        return abi.encode(paid, got);
    }
}
