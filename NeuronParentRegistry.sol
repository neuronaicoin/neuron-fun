// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/**
 * @title NeuronParentRegistry
 * @notice The list of tokens a Neuron.fun launch may choose as its Parent,
 * and for each one the Uniswap v4 pool its buybacks trade through.
 *
 * - Every route is a v4 pool of native ETH (currency0, address zero) against
 *   the Parent (currency1). Its hook must be none or on the hook allowlist.
 * - Delisting stops new launches from choosing a Parent. Its route stays, so
 *   children launched earlier keep buying it back and burning it.
 * - `operator` is the keeper allowed to run buybacks, because a buyback
 *   carries a slippage floor. The operator can delay a buyback, never
 *   redirect it: bought tokens always go to the dead address.
 */
contract NeuronParentRegistry is Ownable2Step {
    struct ParentInfo {
        PoolKey route;
        bool listed;
        bool known;
    }

    mapping(address parent => ParentInfo) private _parents;
    mapping(address hook => bool) public allowedHooks;
    address public operator;

    event ParentSet(address indexed parent, bytes32 routeId);
    event ParentDelisted(address indexed parent);
    event HookAllowed(address indexed hook, bool allowed);
    event OperatorSet(address indexed previousOperator, address indexed newOperator);

    error ZeroAddress();
    error UnknownParent(address parent);
    error RouteNotEthToParent();
    error HookNotAllowed(address hook);
    error RenounceDisabled();

    constructor(address owner_, address operator_) Ownable(owner_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(address(0), operator_);
    }

    /// @notice Lists `parent`, or replaces its route. `route` must be the
    /// native-ETH / parent v4 pool the buybacks will use.
    function setParent(address parent, PoolKey calldata route) external onlyOwner {
        if (parent == address(0)) revert ZeroAddress();
        if (Currency.unwrap(route.currency0) != address(0) || Currency.unwrap(route.currency1) != parent) {
            revert RouteNotEthToParent();
        }
        address hook = address(route.hooks);
        if (hook != address(0) && !allowedHooks[hook]) revert HookNotAllowed(hook);

        _parents[parent] = ParentInfo({route: route, listed: true, known: true});
        emit ParentSet(parent, keccak256(abi.encode(route)));
    }

    /// @notice New launches can no longer choose `parent`; existing children
    /// keep their route.
    function delistParent(address parent) external onlyOwner {
        ParentInfo storage info = _parents[parent];
        if (!info.known) revert UnknownParent(parent);
        info.listed = false;
        emit ParentDelisted(parent);
    }

    function setHookAllowed(address hook, bool allowed) external onlyOwner {
        if (hook == address(0)) revert ZeroAddress();
        allowedHooks[hook] = allowed;
        emit HookAllowed(hook, allowed);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Whether new launches may choose `parent`.
    function isListed(address parent) external view returns (bool) {
        return _parents[parent].listed;
    }

    /// @notice The buyback route of `parent`. Reverts if it was never listed.
    function routeOf(address parent) external view returns (PoolKey memory) {
        ParentInfo storage info = _parents[parent];
        if (!info.known) revert UnknownParent(parent);
        return info.route;
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
