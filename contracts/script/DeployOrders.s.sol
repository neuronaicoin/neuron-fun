// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OmniOrders} from "../src/omni/OmniOrders.sol";

/// @notice Deploys the v6 auto-orders contract (take profit, stop loss, buy the dip) on one
/// chain. It holds buy orders' dollars in the chain's v6 dollar token, read from
/// deployments/omni/<chainid>.json (written by DeployOmni).
contract DeployOrders is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        string memory j = vm.readFile(string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/omni/")), vm.toString(block.chainid), ".json"));
        address usd = vm.parseJsonAddress(j, ".usd");
        require(usd.code.length > 0, "v6 dollar token not found on this chain");
        vm.startBroadcast(key);
        OmniOrders orders = new OmniOrders(IERC20(usd));
        vm.stopBroadcast();
        console2.log("Chain id:     ", block.chainid);
        console2.log("Dollar token: ", usd);
        console2.log("OmniOrders:   ", address(orders));
        console2.log("Start block:  ", block.number);
    }
}
