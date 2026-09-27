// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IGraduatedPools {
    function poolKeyFor(address token) external view returns (PoolKey memory);
    function positions(address token) external view returns (uint256 tokenId, address creator);
}

/**
 * @title NeuronPoolRouter
 * @notice Buys and sells graduated coins in the locked pools the migrator
 * created. Nothing else: only those pools, no owner, no extra fee (the pool
 * already charges 1%), nothing left behind in the contract.
 *
 * - Exact input only; every trade has a minimum output and a deadline.
 * - Unused native coin is refunded in the same transaction.
 * - Each trade emits PoolTrade with the real trader, so the site can show
 *   who bought and sold after graduation.
 */
contract NeuronPoolRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IGraduatedPools public immutable pools;

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
    error RefundFailed();

    struct Job {
        bool isBuy;
        address token;
        uint256 amountIn;
        address payer;
        address recipient;
    }

    constructor(IPoolManager poolManager_, IGraduatedPools pools_) {
        if (address(poolManager_) == address(0) || address(pools_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        pools = pools_;
    }

    /// @notice Spends all of msg.value on `token`. Tokens go to `recipient`.
    function buy(address token, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        tokensOut = _trade(Job(true, token, msg.value, msg.sender, recipient), minTokensOut, deadline);
    }

    /// @notice Sells `amountIn` of `token` (approve this contract first). Native coin goes to `recipient`.
    function sell(address token, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline)
        external
        nonReentrant
        returns (uint256 nativeOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        nativeOut = _trade(Job(false, token, amountIn, msg.sender, recipient), minNativeOut, deadline);
    }

    function _trade(Job memory job, uint256 minOut, uint256 deadline) private returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        if (job.recipient == address(0)) revert ZeroAddress();
        (uint256 tokenId,) = pools.positions(job.token);
        if (tokenId == 0) revert NotGraduated();

        (uint256 paid, uint256 got) = abi.decode(poolManager.unlock(abi.encode(job)), (uint256, uint256));
        out = got;
        if (out < minOut) revert Slippage(out, minOut);

        // A buy that hit the price limit spends less than sent: return the rest.
        if (job.isBuy && paid < job.amountIn) {
            (bool ok,) = payable(job.payer).call{value: job.amountIn - paid}("");
            if (!ok) revert RefundFailed();
        }

        (uint160 sqrtP,,,) = poolManager.getSlot0(pools.poolKeyFor(job.token).toId());
        emit PoolTrade(job.token, job.payer, job.isBuy, job.isBuy ? paid : out, job.isBuy ? out : paid, sqrtP);
    }

    /// @dev Called by the PoolManager inside unlock(). Returns (amount paid, amount received).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Job memory job = abi.decode(data, (Job));
        PoolKey memory key = pools.poolKeyFor(job.token);

        // currency0 is the native coin, currency1 the token.
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: job.isBuy,
                amountSpecified: -int256(job.amountIn),
                sqrtPriceLimitX96: job.isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();

        uint256 paid;
        uint256 got;
        if (job.isBuy) {
            paid = uint256(uint128(-a0));
            got = uint256(uint128(a1));
            poolManager.settle{value: paid}();
            poolManager.take(key.currency1, job.recipient, got);
        } else {
            paid = uint256(uint128(-a1));
            got = uint256(uint128(a0));
            poolManager.sync(key.currency1);
            IERC20(job.token).safeTransferFrom(job.payer, address(poolManager), paid);
            poolManager.settle();
            poolManager.take(key.currency0, job.recipient, got);
        }
        return abi.encode(paid, got);
    }

    /// @dev Only the PoolManager may send native coin here (never during a trade in practice).
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }
}
