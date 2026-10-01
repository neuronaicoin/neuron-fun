// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LaunchCoin} from "./LaunchCoin.sol";
import {UsdCurveV6} from "./UsdCurveV6.sol";
import {Create3} from "./Create3.sol";

/**
 * @notice Holds the coin's bytecode for OmniFactory (which would otherwise be over the
 * 24 KB contract limit) and deploys coins with CREATE3. Coins land at addresses that
 * depend only on THIS contract and the salt, so it must have the same address on every
 * chain: it is deployed by the factory wallet at nonce 0, before the factory (nonce 1).
 * Only the factory can use it.
 */
contract OmniCoinDeployer {
    address public immutable factory;

    error NotFactory();

    constructor(address factory_) {
        factory = factory_;
    }

    function deploy(bytes32 salt, bytes calldata constructorArgs) external returns (address) {
        if (msg.sender != factory) revert NotFactory();
        return Create3.deploy(salt, abi.encodePacked(type(LaunchCoin).creationCode, constructorArgs));
    }

    function predict(bytes32 salt) external view returns (address) {
        return Create3.predict(salt, address(this));
    }
}

/// @notice Holds the curve's bytecode for OmniFactory. Only the factory can use it.
contract OmniCurveDeployer {
    address public immutable factory;

    error NotFactory();

    constructor(address factory_) {
        factory = factory_;
    }

    function deploy(UsdCurveV6.Params calldata p) external returns (address) {
        if (msg.sender != factory) revert NotFactory();
        return address(new UsdCurveV6(p));
    }
}
