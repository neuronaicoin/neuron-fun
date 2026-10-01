// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Deploys a contract to an address that depends only on the deployer and a salt
/// (not on the contract's code or constructor arguments), so the same coin lands at the
/// same address on every chain even though its constructor gets that chain's endpoint.
/// Same technique as Solady's CREATE3: a tiny CREATE2 proxy that CREATEs the contract.
library Create3 {
    /// @dev Proxy that CREATEs whatever init code it is called with.
    bytes internal constant PROXY_CODE = hex"67363d3d37363d34f03d5260086018f3";
    bytes32 internal constant PROXY_CODE_HASH = keccak256(PROXY_CODE);

    error DeployFailed();

    function deploy(bytes32 salt, bytes memory creationCode) internal returns (address deployed) {
        bytes memory proxyCode = PROXY_CODE;
        address proxy;
        assembly {
            proxy := create2(0, add(proxyCode, 32), mload(proxyCode), salt)
        }
        if (proxy == address(0)) revert DeployFailed();
        deployed = _childOf(proxy);
        (bool ok,) = proxy.call(creationCode);
        if (!ok || deployed.code.length == 0) revert DeployFailed();
    }

    function predict(bytes32 salt, address deployer) internal pure returns (address) {
        address proxy = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, PROXY_CODE_HASH)))));
        return _childOf(proxy);
    }

    /// @dev Address of the first contract a fresh proxy CREATEs (nonce 1).
    function _childOf(address proxy) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }
}
