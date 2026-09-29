// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SasaOrders} from "../src/curve/SasaOrders.sol";

/// @notice Deploys the auto-orders contract (take profit, stop loss, buy the dip) on one chain.
contract DeployOrders is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        SasaOrders orders = new SasaOrders();
        vm.stopBroadcast();
        console2.log("Chain id:     ", block.chainid);
        console2.log("SasaOrders:   ", address(orders));
        console2.log("Start block:  ", block.number);
    }
}
