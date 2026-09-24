// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PairPadLaunchFactory} from "../src/v2/PairPadLaunchFactory.sol";
import {PairPadLaunchLocker} from "../src/v2/PairPadLaunchLocker.sol";
import {PairPadRouter} from "../src/v2/PairPadRouter.sol";
import {PairPadLauncherToken} from "../src/v2/PairPadLauncherToken.sol";
import {NeuronLauncher} from "../src/neuron/NeuronLauncher.sol";
import {NeuronParentSplitter} from "../src/neuron/NeuronParentSplitter.sol";

/**
 * @notice One full Neuron.fun cycle on Robinhood Chain testnet, against the
 * deployed contracts: launch a child of $NEURON, trade it, collect the fees,
 * split them, buy back and burn $NEURON, pay the creator.
 *
 * Amounts are tiny so a faucet-funded wallet can run it. The deployer is
 * the registry's operator, so it may run the buyback.
 *
 *   PRIVATE_KEY=0x... forge script script/TestnetSmoke.s.sol --rpc-url <rpc> [--broadcast]
 */
contract TestnetSmoke is Script {
    uint256 internal constant TESTNET = 46630;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Testnet deployment of 24 Sep 2026 (DeployNeuron.s.sol).
    address internal constant FACTORY = 0x58068303Ca51EbB8FC25B594361186a52D6071E5;
    address internal constant LOCKER = 0x44dd76F2eAfd6708c63DB93c03804F4f15017dFd;
    address internal constant ROUTER = 0xFeFC59c4CE3Df167bb1CEa6739501d7240FF5383;
    address internal constant LAUNCHER = 0x4c283e95627FA53beD6bA03dA2d1C6866e14c9f1;
    address internal constant NEURON = 0xC348b269920e0c1f0a0838837D2474984439A4D9;

    uint256 internal constant DEV_BUY = 0.0005 ether;
    uint256 internal constant TRADE_BUY = 0.001 ether;

    function run() external {
        require(block.chainid == TESTNET, "testnet only");
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);

        PairPadLaunchFactory factory = PairPadLaunchFactory(FACTORY);
        PairPadLaunchLocker locker = PairPadLaunchLocker(payable(LOCKER));
        PairPadRouter router = PairPadRouter(payable(ROUTER));
        NeuronLauncher launcher = NeuronLauncher(LAUNCHER);

        uint256 fee = factory.launchFee();
        uint256 needed = fee + DEV_BUY + TRADE_BUY + 0.001 ether; // plus gas headroom
        console2.log("Wallet:                  ", me);
        console2.log("Balance before (wei):    ", me.balance);
        require(me.balance >= needed, "wallet balance too low for the smoke run");

        uint256 neuronBurnedBefore = IERC20(NEURON).balanceOf(DEAD);
        string memory tag = vm.toString(block.timestamp);

        vm.startBroadcast(key);

        // 1. Launch a child of $NEURON, with a small first buy.
        PairPadLaunchFactory.TokenParams memory p = PairPadLaunchFactory.TokenParams({
            name: string.concat("Neuron Test Child ", tag),
            symbol: "NTC",
            logo: "",
            description: "Testnet smoke run: a child of $NEURON.",
            socials: PairPadLauncherToken.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            expectedEconomics: bytes32(0),
            salt: keccak256(bytes(tag))
        });
        (address child, address s, uint256 devTokens) = launcher.launch{value: fee + DEV_BUY}(p, NEURON, 0);
        NeuronParentSplitter splitter = NeuronParentSplitter(payable(s));

        // 2. Trade: buy, then sell half of everything held.
        PoolKey memory childKey = factory.poolKeyFor(child);
        router.swapExactIn{value: TRADE_BUY}(childKey, true, TRADE_BUY, 0, me);
        uint256 toSell = IERC20(child).balanceOf(me) / 2;
        IERC20(child).approve(ROUTER, toSell);
        router.swapExactIn(childKey, false, toSell, 0, me);

        // 3. Collect the pool fees into the escrow, then split them.
        locker.collectFees(child);
        splitter.sync();
        uint256 parentEth = splitter.parentEth();
        uint256 creatorEth = splitter.creatorEth();

        // 4. Buy back and burn $NEURON, then pay the creator.
        uint256 neuronBurned;
        if (parentEth > 0) neuronBurned = splitter.buybackParent(parentEth, 1);
        uint256 paid = splitter.payCreator();

        vm.stopBroadcast();

        console2.log("--- results ---");
        console2.log("Child token:             ", child);
        console2.log("Splitter:                ", s);
        console2.log("Dev-buy tokens:          ", devTokens);
        console2.log("Parent ETH (wei):        ", parentEth);
        console2.log("Creator ETH (wei):       ", creatorEth);
        console2.log("Creator paid (wei):      ", paid);
        console2.log("Child tokens burned:     ", splitter.totalChildBurned());
        console2.log("NEURON burned this run:  ", neuronBurned);
        console2.log("NEURON at dead address:  ", IERC20(NEURON).balanceOf(DEAD));
        console2.log("NEURON dead before:      ", neuronBurnedBefore);
        console2.log("Splitter ETH left (wei): ", s.balance);
        console2.log("Balance after (wei):     ", me.balance);

        require(neuronBurned > 0, "no NEURON was burned");
        require(IERC20(NEURON).balanceOf(DEAD) == neuronBurnedBefore + neuronBurned, "burn not at dead address");
        require(s.balance == 0, "splitter kept ETH");
    }
}
