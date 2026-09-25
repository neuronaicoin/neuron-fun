// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {NeuronCurve} from "../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../src/curve/NeuronCurveFactory.sol";

/**
 * @notice Creates a coin on the testnet curve factory, buys some and sells a
 * quarter back, so the graduation keeper has something to decide on.
 *
 *   PRIVATE_KEY=0x... FACTORY=0x... forge script script/TestnetCurveSmoke.s.sol --rpc-url <rpc> [--broadcast]
 */
contract TestnetCurveSmoke is Script {
    uint256 internal constant FIRST_BUY = 0.002 ether;

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        NeuronCurveFactory factory = NeuronCurveFactory(payable(vm.envAddress("FACTORY")));
        require(me.balance > FIRST_BUY + 0.001 ether, "wallet balance too low");
        string memory tag = vm.toString(block.timestamp);

        vm.startBroadcast(key);
        (address curveAddr, address token, uint256 bought) = factory.launch{value: FIRST_BUY}(
            string.concat("Neuron Curve Test ", tag), "NCT", "", "Testnet smoke run of the Neuron.fun curve.",
            keccak256(bytes(tag)), 0
        );
        NeuronCurve curve = NeuronCurve(payable(curveAddr));
        uint256 toSell = bought / 4;
        curve.token().approve(curveAddr, toSell);
        uint256 got = curve.sell(toSell, 0, me);
        vm.stopBroadcast();

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
