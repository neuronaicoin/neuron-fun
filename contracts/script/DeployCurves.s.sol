// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {NeuronCurveFactory} from "../src/curve/NeuronCurveFactory.sol";
import {NeuronGraduationHook} from "../src/curve/NeuronGraduationHook.sol";
import {NeuronV4Migrator, ICurveRegistry} from "../src/curve/NeuronV4Migrator.sol";

interface IPositionManagerPoolManager {
    function poolManager() external view returns (address);
}

/**
 * @notice Deploys the Neuron.fun multi-chain launch system on one chain:
 * migrator (with its pool-guard hook), curve factory, and the link between
 * them. Run once per chain.
 *
 *   PRIVATE_KEY=0x... forge script script/DeployCurves.s.sol --rpc-url <rpc> [--broadcast]
 *
 * Uniswap v4 addresses default by chain id and can be overridden with
 * POOL_MANAGER / POSITION_MANAGER / PERMIT2. They are checked on-chain
 * before anything is sent.
 *
 * Curve terms (env, in wei of the chain's gas coin where relevant):
 *   VIRTUAL_NATIVE (default 1 ether)   MIN_GRADUATION (default 0.5 ether)
 *   OPERATOR, PROTOCOL_FEE_RECIPIENT   (default: the deployer)
 */
contract DeployCurves is Script {
    address internal constant PERMIT2_CANONICAL = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct V4 {
        address poolManager;
        address positionManager;
        address permit2;
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address operator = vm.envOr("OPERATOR", deployer);
        address feeRecipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", deployer);

        V4 memory v4 = _v4();
        require(v4.poolManager.code.length > 0, "PoolManager not found on this chain");
        require(v4.positionManager.code.length > 0, "PositionManager not found on this chain");
        require(v4.permit2.code.length > 0, "Permit2 not found on this chain");
        require(
            IPositionManagerPoolManager(v4.positionManager).poolManager() == v4.poolManager,
            "PositionManager belongs to a different PoolManager"
        );

        NeuronCurveFactory.Config memory cfg = NeuronCurveFactory.Config({
            virtualNative: vm.envOr("VIRTUAL_NATIVE", uint256(1 ether)),
            virtualToken: 1_073_000_000 ether,
            tokensForSale: 793_100_000 ether,
            graduationTokens: 206_900_000 ether,
            feeBps: 100,
            creatorShareBps: 3_000,
            minGraduationNative: vm.envOr("MIN_GRADUATION", uint256(0.5 ether))
        });

        // The migrator is the deployer's next contract; find the salt that
        // gives its hook exactly the before-initialize flag.
        address migratorAddr = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        bytes32 salt = _mineHookSalt(v4.poolManager, migratorAddr);

        console2.log("Chain id:           ", block.chainid);
        console2.log("Deployer:           ", deployer);
        console2.log("Balance (wei):      ", deployer.balance);

        vm.startBroadcast(key);
        NeuronV4Migrator migrator = new NeuronV4Migrator(
            IPoolManager(v4.poolManager),
            IPositionManager(v4.positionManager),
            IAllowanceTransfer(v4.permit2),
            feeRecipient,
            3_000,
            salt
        );
        require(address(migrator) == migratorAddr, "migrator address moved");
        NeuronCurveFactory factory = new NeuronCurveFactory(deployer, migrator, operator, feeRecipient, cfg);
        migrator.bindCurves(ICurveRegistry(address(factory)));
        factory.setLaunchesOpen(true);
        vm.stopBroadcast();

        console2.log("--- Neuron.fun curves ---");
        console2.log("NeuronCurveFactory: ", address(factory));
        console2.log("NeuronV4Migrator:   ", address(migrator));
        console2.log("GraduationHook:     ", address(migrator.hook()));
        console2.log("Operator:           ", operator);
        console2.log("Start block:        ", block.number);
    }

    function _v4() internal view returns (V4 memory v) {
        if (block.chainid == 4663 || block.chainid == 46630) {
            // Robinhood Chain mainnet and testnet share Uniswap's v4 addresses.
            v = V4(0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x58daec3116aae6D93017bAAea7749052E8a04fA7, PERMIT2_CANONICAL);
        } else if (block.chainid == 8453) {
            v = V4(0x498581fF718922c3f8e6A244956aF099B2652b2b, 0x7C5f5A4bBd8fD63184577525326123B519429bDc, PERMIT2_CANONICAL);
        } else if (block.chainid == 84532) {
            v = V4(0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408, 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80, PERMIT2_CANONICAL);
        }
        v.poolManager = vm.envOr("POOL_MANAGER", v.poolManager);
        v.positionManager = vm.envOr("POSITION_MANAGER", v.positionManager);
        v.permit2 = vm.envOr("PERMIT2", v.permit2 == address(0) ? PERMIT2_CANONICAL : v.permit2);
        require(v.poolManager != address(0), "no Uniswap v4 addresses for this chain; set POOL_MANAGER and POSITION_MANAGER");
    }

    function _mineHookSalt(address poolManager, address migratorAddr) internal pure returns (bytes32) {
        bytes32 initHash =
            keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(poolManager, migratorAddr)));
        for (uint256 i; i < 2_000_000; ++i) {
            address h = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), migratorAddr, bytes32(i), initHash))))
            );
            if (uint160(h) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_INITIALIZE_FLAG) return bytes32(i);
        }
        revert("no hook salt found");
    }
}
