// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {NeuronCurve} from "../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../src/curve/NeuronCurveFactory.sol";

/**
 * @notice Creates a coin on a testnet curve factory and buys some, so the
 * graduation keeper has something to decide on.
 *
 * To launch the same coin on several chains, run it once per chain with the
 * same LAUNCH_KEY (and NAME): the keeper groups curves by creator + key.
 *
 *   PRIVATE_KEY=0x... FACTORY=0x... forge script script/TestnetCurveSmoke.s.sol --rpc-url <rpc> [--broadcast]
 *
 * Optional env: LAUNCH_KEY (text), NAME, FIRST_BUY (wei, default 0.002 ether),
 * SELL_QUARTER (true/false, default true).
 */
contract TestnetCurveSmoke is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        NeuronCurveFactory factory = NeuronCurveFactory(payable(vm.envAddress("FACTORY")));
        uint256 firstBuy = vm.envOr("FIRST_BUY", uint256(0.002 ether));
        bool sellQuarter = vm.envOr("SELL_QUARTER", true);
        string memory tag = vm.envOr("LAUNCH_KEY", vm.toString(block.timestamp));
        string memory name = vm.envOr("NAME", string.concat("Neuron Curve Test ", tag));
        require(me.balance > firstBuy + 0.0005 ether, "wallet balance too low");

        vm.startBroadcast(key);
        (address curveAddr, address token, uint256 bought) = factory.launch{value: firstBuy}(
            name, "NCT", "", "Testnet smoke run of the Neuron.fun curve.", keccak256(bytes(tag)), 0
        );
        NeuronCurve curve = NeuronCurve(payable(curveAddr));
        uint256 toSell;
        uint256 got;
        if (sellQuarter) {
            toSell = bought / 4;
            curve.token().approve(curveAddr, toSell);
            got = curve.sell(toSell, 0, me);
        }
        vm.stopBroadcast();

        console2.log("Launch key:        ", tag);
        console2.log("Curve:             ", curveAddr);
        console2.log("Token:             ", token);
        console2.log("Bought (tokens):   ", bought);
        console2.log("Sold back (tokens):", toSell);
        console2.log("Got back (wei):    ", got);
        console2.log("Curve holds (wei): ", curve.realNative());
        console2.log("Graduation min:    ", curve.minGraduationNative());
        require(curve.realNative() >= curve.minGraduationNative(), "below graduation minimum");
    }
}
