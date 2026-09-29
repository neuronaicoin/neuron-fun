// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SasaFeeSplitter} from "../src/curve/SasaFeeSplitter.sol";
import {PairPadDisperseV2} from "../src/fees/PairPadDisperseV2.sol";
import {NeuronCurveFactory} from "../src/curve/NeuronCurveFactory.sol";

/**
 * @notice Sets up daily rewards on one chain: the fee splitter (sasa's fee
 * share lands here, 30% goes to the rewards wallet, 70% to the treasury) and
 * the batch payer the rewards job uses. If FACTORY is given and the deployer
 * still owns it, new coins' fees are pointed at the splitter right away.
 *
 *   PRIVATE_KEY   deployer
 *   REWARDS       the rewards wallet's address (its key lives only in Railway)
 *   TREASURY      where the other 70% goes (default: SAFE, else the deployer)
 *   SAFE          owner of the splitter at mainnet (default: the deployer)
 *   FACTORY       the live curve factory on this chain (optional)
 *   REWARDS_BPS   rewards share in basis points (default 3000 = 30%)
 */
contract DeployRewards is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address rewards = vm.envAddress("REWARDS");
        address safe = vm.envOr("SAFE", address(0));
        address treasury = vm.envOr("TREASURY", safe == address(0) ? deployer : safe);
        address owner = safe == address(0) ? deployer : safe;
        address factory = vm.envOr("FACTORY", address(0));
        uint16 bps = uint16(vm.envOr("REWARDS_BPS", uint256(3_000)));
        require(rewards != address(0) && rewards != deployer, "REWARDS must be its own wallet");
        if (safe != address(0)) require(safe.code.length > 0, "SAFE has no contract on this chain");

        vm.startBroadcast(key);
        SasaFeeSplitter splitter = new SasaFeeSplitter(owner, treasury, rewards, bps);
        PairPadDisperseV2 disperse = new PairPadDisperseV2();
        bool pointed = false;
        if (factory != address(0) && NeuronCurveFactory(payable(factory)).owner() == deployer) {
            NeuronCurveFactory(payable(factory)).setProtocolFeeRecipient(address(splitter));
            pointed = true;
        }
        vm.stopBroadcast();

        console2.log("Chain id:          ", block.chainid);
        console2.log("SasaFeeSplitter:   ", address(splitter));
        console2.log("Disperse:          ", address(disperse));
        console2.log("Rewards wallet:    ", rewards);
        console2.log("Treasury:          ", treasury);
        console2.log("Owner:             ", owner);
        console2.log("Rewards bps:       ", bps);
        console2.log("Factory fees -> splitter:", pointed);
    }
}
