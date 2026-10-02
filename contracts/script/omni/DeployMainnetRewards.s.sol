// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UsdFeeSplitter} from "../../src/usd/UsdFeeSplitter.sol";
import {PairPadDisperseV2} from "../../src/fees/PairPadDisperseV2.sol";
import {SasaBoost} from "../../src/omni/SasaBoost.sol";

/**
 * @notice Mainnet step 0 (before DeployOmni): sasa's fee splitter and the payout contract.
 * Every coin's sasa fee share goes to the splitter, which sends 30% to the rewards wallet
 * (referral and copy rewards, paid by the rewards service) and 70% to the treasury.
 * Env: PRIVATE_KEY, USD_TOKEN, REWARDS (rewards wallet), ADMIN (owner and treasury).
 * Writes deployments/mainnet/<chainid>-rewards.json; DeployOmni then uses the splitter as
 * the protocol fee recipient.
 */
contract DeployMainnetRewards is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address usd = vm.envAddress("USD_TOKEN");
        address rewards = vm.envAddress("REWARDS");
        address admin = vm.envAddress("ADMIN");
        require(usd.code.length > 0, "USD_TOKEN has no code here");
        require(admin != vm.addr(key), "ADMIN must not be the deployer");
        string memory dir = vm.envOr("DEPLOY_DIR", string("./deployments/mainnet/"));

        vm.startBroadcast(key);
        // Owned by the admin from the start (two-step ownership: nothing to hand over later).
        UsdFeeSplitter splitter = new UsdFeeSplitter(admin, admin, rewards, 3_000, IERC20(usd));
        PairPadDisperseV2 disperse = new PairPadDisperseV2();
        // Paid placement ("Boosted" row): payments straight to the treasury.
        SasaBoost boost = new SasaBoost(IERC20(usd), admin, admin);
        vm.stopBroadcast();

        string memory j = "rewards";
        vm.serializeAddress(j, "splitter", address(splitter));
        vm.serializeAddress(j, "rewardsWallet", rewards);
        vm.serializeAddress(j, "treasury", admin);
        vm.serializeAddress(j, "boost", address(boost));
        string memory out = vm.serializeAddress(j, "disperse", address(disperse));
        vm.writeJson(out, string.concat(dir, vm.toString(block.chainid), "-rewards.json"));
        console2.log("UsdFeeSplitter:", address(splitter));
        console2.log("Disperse:      ", address(disperse));
        console2.log("SasaBoost:     ", address(boost));
    }
}
