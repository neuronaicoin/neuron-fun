// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/**
 * @title NeuronGraduationHook
 * @notice The only thing this hook does: it lets nobody but the migrator
 * create a pool that uses it. Graduated coins trade in pools keyed to this
 * hook, so nobody can open that pool early at a bad price or seed it with
 * liquidity before the coin graduates. After creation the pool is an
 * ordinary pool: this hook has no other permission and cannot touch swaps,
 * liquidity or fees.
 *
 * Its address must carry only the before-initialize flag (see Hooks.sol),
 * which the deployer arranges with a CREATE2 salt.
 */
contract NeuronGraduationHook is IHooks {
    address public immutable poolManager;
    address public immutable migrator;

    error NotPoolManager();
    error OnlyMigratorMayCreatePools();
    error HookNotImplemented();

    constructor(address poolManager_, address migrator_) {
        poolManager = poolManager_;
        migrator = migrator_;
    }

    function beforeInitialize(address sender, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != poolManager) revert NotPoolManager();
        if (sender != migrator) revert OnlyMigratorMayCreatePools();
        return IHooks.beforeInitialize.selector;
    }

    // Every other hook point is switched off by the address flags; the
    // PoolManager never calls these.

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
