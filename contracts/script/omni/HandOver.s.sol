// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OmniFactory} from "../../src/omni/OmniFactory.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {AcrossUsdBridge} from "../../src/omni/AcrossUsdBridge.sol";

/**
 * @notice Last mainnet step, after deploy + wire on every chain: sets the emergency guardian
 * and the beta money cap, then hands every owner role to the admin wallet (later a Safe).
 * Env: PRIVATE_KEY (the deployer, current owner), ADMIN, GUARDIAN, NATIVE_CAP (dollars, 6
 * decimals; 0 = no cap). Checks every result before finishing.
 */
contract HandOver is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN");
        address guardian = vm.envAddress("GUARDIAN");
        uint256 cap = vm.envUint("NATIVE_CAP");
        require(admin != address(0) && guardian != address(0), "ADMIN / GUARDIAN missing");
        require(admin != vm.addr(key), "ADMIN must not be the deployer");

        string memory j = vm.readFile(string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/omni/")), vm.toString(block.chainid), ".json"));
        OmniFactory factory = OmniFactory(vm.parseJsonAddress(j, ".factory"));
        OmniHub hub = OmniHub(payable(vm.parseJsonAddress(j, ".hub")));
        AcrossUsdBridge bridge = AcrossUsdBridge(vm.parseJsonAddress(j, ".bridge"));
        require(bridge.locked(), "lock the bridge routes (wire with LOCK_BRIDGE=true) before handing over");

        vm.startBroadcast(key);
        factory.setGuardian(guardian);
        factory.setNativeCap(cap);
        // LayerZero settings belong to the owner too (the OApp delegate).
        hub.setDelegate(admin);
        factory.transferOwnership(admin);
        hub.transferOwnership(admin);
        bridge.transferOwnership(admin);
        vm.stopBroadcast();

        require(factory.owner() == admin && hub.owner() == admin && bridge.owner() == admin, "owner not handed over");
        require(factory.guardian() == guardian && factory.nativeCap() == cap, "guardian / cap not set");
        console2.log("owner    ", admin);
        console2.log("guardian ", guardian);
        console2.log("cap      ", cap);
    }
}
