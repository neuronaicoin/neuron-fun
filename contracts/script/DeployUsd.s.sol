// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {NeuronGraduationHook} from "../src/curve/NeuronGraduationHook.sol";
import {TestUSDC} from "../src/usd/TestUSDC.sol";
import {UsdCurveFactory} from "../src/usd/UsdCurveFactory.sol";
import {UsdV4Migrator, IUsdCurveRegistry, IUsdBuybackRouter} from "../src/usd/UsdV4Migrator.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../src/usd/UsdPoolRouter.sol";
import {UsdFeeSplitter} from "../src/usd/UsdFeeSplitter.sol";
import {UsdOrders} from "../src/usd/UsdOrders.sol";

interface IPosmPoolManager {
    function poolManager() external view returns (address);
}

/**
 * @notice Deploys sasa's dollar edition (v5) on one chain: every coin trades
 * against USDC. In one run: (Test)USDC, fee splitter, migrator + its hook,
 * curve factory, pool router, auto-orders; all wired together.
 *
 *   PRIVATE_KEY=0x... forge script script/DeployUsd.s.sol --rpc-url <rpc> [--broadcast]
 *
 * Adding a chain later (BNB, Arc, ...): set POOL_MANAGER and POSITION_MANAGER
 * (Uniswap v4 on that chain), USDC (its real USDC), and run the same script.
 *
 * Env:
 *   USDC            the chain's USDC. Empty on a testnet = deploy TestUSDC (free faucet).
 *   REWARDS         rewards wallet (gets 30% of sasa's fees for invite/copy rewards)
 *   TREASURY        where the other 70% goes (default: SAFE, else the deployer)
 *   SAFE            multisig to own everything (offered here, it must accept)
 *   GUARDIAN        hot key that can only pause buys and launches
 *   OPERATOR        graduation keeper (default: the deployer)
 *   VIRTUAL_USD     curve's virtual USDC, 6 decimals (default $1,000)
 *   MIN_GRADUATION  least USDC a curve must hold to graduate (default $1,000)
 *   USD_CAP         beta cap on USDC held by all curves together (0 = none)
 */
contract DeployUsd is Script {
    address internal constant PERMIT2_CANONICAL = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct V4 {
        address poolManager;
        address positionManager;
        address permit2;
    }

    struct Out {
        address usdc;
        address splitter;
        address migrator;
        address factory;
        address router;
        address orders;
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address safe = vm.envOr("SAFE", address(0));
        address owner = safe == address(0) ? deployer : safe;
        address treasury = vm.envOr("TREASURY", owner);
        address rewards = vm.envAddress("REWARDS");
        address guardian = vm.envOr("GUARDIAN", address(0));
        address operator = vm.envOr("OPERATOR", deployer);
        uint256 cap = vm.envOr("USD_CAP", uint256(0));
        address usdcEnv = vm.envOr("USDC", address(0));
        require(rewards != address(0) && rewards != deployer, "REWARDS must be its own wallet");
        if (safe != address(0)) require(safe.code.length > 0, "SAFE has no contract on this chain");
        bool testnet = block.chainid == 46630 || block.chainid == 84532 || block.chainid == 31337;
        if (usdcEnv == address(0)) require(testnet, "set USDC (the chain's real USDC) on mainnets");
        else require(usdcEnv.code.length > 0, "USDC has no contract on this chain");

        V4 memory v4 = _v4();
        require(v4.poolManager.code.length > 0, "PoolManager not found on this chain");
        require(v4.positionManager.code.length > 0, "PositionManager not found on this chain");
        require(v4.permit2.code.length > 0, "Permit2 not found on this chain");
        require(IPosmPoolManager(v4.positionManager).poolManager() == v4.poolManager, "PositionManager/PoolManager mismatch");

        UsdCurveFactory.Config memory cfg = UsdCurveFactory.Config({
            virtualNative: vm.envOr("VIRTUAL_USD", uint256(1_000e6)),
            virtualToken: 1_073_000_000 ether,
            tokensForSale: 793_100_000 ether,
            graduationTokens: 206_900_000 ether,
            feeBps: 100,
            creatorShareBps: 3_000,
            minGraduationNative: vm.envOr("MIN_GRADUATION", uint256(1_000e6))
        });

        // Contracts are created in this order, so the migrator's address (and
        // with it the hook salt) is known up front.
        uint256 nonce = vm.getNonce(deployer);
        uint256 before = usdcEnv == address(0) ? 2 : 1; // [TestUSDC], splitter
        address migratorAddr = vm.computeCreateAddress(deployer, nonce + before);
        bytes32 salt = _mineHookSalt(v4.poolManager, migratorAddr);

        console2.log("Chain id:        ", block.chainid);
        console2.log("Deployer:        ", deployer);

        Out memory o;
        vm.startBroadcast(key);
        o.usdc = usdcEnv == address(0) ? address(new TestUSDC()) : usdcEnv;
        UsdFeeSplitter splitter = new UsdFeeSplitter(owner, treasury, rewards, 3_000, IERC20(o.usdc));
        o.splitter = address(splitter);
        UsdV4Migrator migrator = new UsdV4Migrator(
            IPoolManager(v4.poolManager),
            IPositionManager(v4.positionManager),
            IAllowanceTransfer(v4.permit2),
            IERC20(o.usdc),
            o.splitter,
            3_000,
            salt
        );
        require(address(migrator) == migratorAddr, "migrator address moved");
        o.migrator = address(migrator);
        UsdCurveFactory factory = new UsdCurveFactory(deployer, migrator, operator, o.splitter, cfg, IERC20(o.usdc));
        o.factory = address(factory);
        migrator.bindCurves(IUsdCurveRegistry(o.factory));
        UsdPoolRouter router = new UsdPoolRouter(IPoolManager(v4.poolManager), IUsdGraduatedPools(o.migrator));
        o.router = address(router);
        migrator.bindRouter(IUsdBuybackRouter(o.router));
        o.orders = address(new UsdOrders(IERC20(o.usdc)));
        factory.setLaunchesOpen(true);
        if (guardian != address(0)) factory.setGuardian(guardian);
        if (cap != 0) factory.setNativeCap(cap);
        if (safe != address(0)) factory.transferOwnership(safe);
        vm.stopBroadcast();

        console2.log("--- sasa USD (v5) ---");
        console2.log("USDC:            ", o.usdc);
        console2.log("TestUSDC faucet: ", usdcEnv == address(0));
        console2.log("UsdFeeSplitter:  ", o.splitter);
        console2.log("UsdV4Migrator:   ", o.migrator);
        console2.log("GraduationHook:  ", address(migrator.hook()));
        console2.log("UsdCurveFactory: ", o.factory);
        console2.log("UsdPoolRouter:   ", o.router);
        console2.log("UsdOrders:       ", o.orders);
        console2.log("Rewards wallet:  ", rewards);
        console2.log("Treasury:        ", treasury);
        console2.log("Guardian:        ", guardian);
        console2.log("Cap (USDC units):", cap);
        console2.log("Owner now:       ", factory.owner());
        console2.log("Start block:     ", block.number);
    }

    function _v4() internal view returns (V4 memory v) {
        if (block.chainid == 4663 || block.chainid == 46630) {
            v = V4(0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x58daec3116aae6D93017bAAea7749052E8a04fA7, PERMIT2_CANONICAL);
        } else if (block.chainid == 8453) {
            v = V4(0x498581fF718922c3f8e6A244956aF099B2652b2b, 0x7C5f5A4bBd8fD63184577525326123B519429bDc, PERMIT2_CANONICAL);
        } else if (block.chainid == 84532) {
            v = V4(0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408, 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80, PERMIT2_CANONICAL);
        }
        // New chains (BNB, Arc, ...): pass these in.
        v.poolManager = vm.envOr("POOL_MANAGER", v.poolManager);
        v.positionManager = vm.envOr("POSITION_MANAGER", v.positionManager);
        v.permit2 = vm.envOr("PERMIT2", v.permit2 == address(0) ? PERMIT2_CANONICAL : v.permit2);
        require(v.poolManager != address(0), "no Uniswap v4 addresses for this chain; set POOL_MANAGER and POSITION_MANAGER");
    }

    function _mineHookSalt(address poolManager, address migratorAddr) internal pure returns (bytes32) {
        bytes32 initHash =
            keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(poolManager, migratorAddr)));
        for (uint256 i; i < 2_000_000; ++i) {
            address h = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), migratorAddr, bytes32(i), initHash)))));
            if (uint160(h) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_INITIALIZE_FLAG) return bytes32(i);
        }
        revert("no hook salt found");
    }
}
