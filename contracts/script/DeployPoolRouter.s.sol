// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {NeuronPoolRouter, IGraduatedPools} from "../src/curve/NeuronPoolRouter.sol";

interface IMigratorView {
    function poolManager() external view returns (address);
}

/**
 * @notice Deploys the router for graduated pools on one chain.
 *   PRIVATE_KEY=0x... MIGRATOR=0x... forge script script/DeployPoolRouter.s.sol --rpc-url <rpc> [--broadcast]
 * The PoolManager is read from the migrator itself, so the two always match.
 */
contract DeployPoolRouter is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address migrator = vm.envAddress("MIGRATOR");
        require(migrator.code.length > 0, "MIGRATOR has no code on this chain");
        address pm = IMigratorView(migrator).poolManager();
        require(pm.code.length > 0, "PoolManager not found");

        vm.startBroadcast(key);
        NeuronPoolRouter router = new NeuronPoolRouter(IPoolManager(pm), IGraduatedPools(migrator));
        vm.stopBroadcast();

        console2.log("Chain id:          ", block.chainid);
        console2.log("NeuronPoolRouter:  ", address(router));
        console2.log("PoolManager:       ", pm);
        console2.log("Migrator:          ", migrator);
    }
}
