// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {IOFT} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../../src/usd/UsdPoolRouter.sol";
import {TestUsdOft} from "../../src/omni/TestUsdOft.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {MigratorV6, IV6BuybackRouter} from "../../src/omni/MigratorV6.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../../src/omni/ConsolidatorV6.sol";
import {OmniFactory} from "../../src/omni/OmniFactory.sol";
import {OmniCoinDeployer, OmniCurveDeployer} from "../../src/omni/OmniDeployers.sol";

/**
 * @notice v6 (omnichain) deployment on ONE testnet. Run it on every chain first, then
 * WireOmni on every chain. Writes the addresses to deployments/omni/<chainid>.json.
 *
 * Two keys:
 *  - PRIVATE_KEY: the usual deployer (hub, money contracts, wiring).
 *  - OMNI_FACTORY_KEY: a fresh wallet used for exactly TWO transactions per chain:
 *    nonce 0 deploys the coin deployer, nonce 1 the factory. Same key + same nonces give
 *    both the same address on every chain, which gives every coin the same address on
 *    every chain (CREATE3).
 *
 * LayerZero addresses come from the environment, which the workflow fills from
 * LayerZero's official deployment list; the script checks the endpoint really is the
 * one for LOCAL_EID before doing anything.
 */
contract DeployOmni is Script {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct Out {
        address usd;
        address hub;
        address bridge;
        address migrator;
        address router;
        address consolidator;
        address factory;
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        uint256 fkey = vm.envUint("OMNI_FACTORY_KEY");
        address deployer = vm.addr(key);
        address fdeployer = vm.addr(fkey);
        address endpoint = vm.envAddress("LZ_ENDPOINT");
        uint32 localEid = uint32(vm.envUint("LOCAL_EID"));
        uint32 coordEid = uint32(vm.envUint("COORD_EID"));
        address rewards = vm.envAddress("REWARDS");
        address treasury = vm.envOr("TREASURY", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        uint8 minDvns = uint8(vm.envOr("MIN_DVNS", uint256(1)));
        address poolManager = vm.envAddress("POOL_MANAGER");
        address positionManager = vm.envAddress("POSITION_MANAGER");

        require(ILayerZeroEndpointV2(endpoint).eid() == localEid, "LZ endpoint is not the one for LOCAL_EID");
        require(fdeployer != deployer, "OMNI_FACTORY_KEY must be a separate wallet");
        address coinDeployerAt = vm.computeCreateAddress(fdeployer, 0);
        address factoryAt = vm.computeCreateAddress(fdeployer, 1);
        require(factoryAt.code.length == 0, "factory already deployed here");
        require(vm.getNonce(fdeployer) == 0, "OMNI_FACTORY_KEY wallet was used before: needs nonce 0 on every chain");

        // Testnet terms: tiny target so faucet money can graduate a coin. Mainnet: 4,500 / 10,000.
        OmniFactory.Config memory cfg = OmniFactory.Config({
            virtualNative: vm.envOr("VIRTUAL_USD", uint256(100e6)),
            virtualToken: 1_073_000_000 ether,
            target: vm.envOr("TARGET_USD", uint256(20e6)),
            feeBps: 100,
            creatorShareBps: 3_000,
            moveFeeBps: 10
        });

        Out memory o;
        // Order (the factory wallet's first two transactions are the only ones that matter):
        //   deployer n   : curve deployer           (cheap)
        //   factory  0,1 : coin deployer, factory  (same addresses on every chain)
        //   factory  2   : optional top-up of the deployer (FUND_DEPLOYER, wei) from what is left
        //   deployer n+1..: usd, hub, bridge, migrator, router, bindRouter, consolidator, setKeeper, setFactory
        // Mainnet: the chain's real dollar (USDC on Base, USDG on Robinhood) and Across for
        // moving money; testnet: our own test dollar (an OFT) and the LayerZero bridge.
        address realUsd = vm.envOr("USD_TOKEN", address(0));
        address spoke = vm.envOr("ACROSS_SPOKE", address(0));
        bool mainnet = realUsd != address(0);
        if (mainnet) {
            require(realUsd.code.length > 0, "USD_TOKEN has no code on this chain");
            require(spoke.code.length > 0, "ACROSS_SPOKE has no code on this chain");
        }
        uint64 n = vm.getNonce(deployer);
        uint64 k = mainnet ? 0 : 1; // the test dollar takes one deployment slot
        address usdAt = mainnet ? realUsd : vm.computeCreateAddress(deployer, n + 1);
        address hubAt = vm.computeCreateAddress(deployer, n + k + 1);
        address bridgeAt = vm.computeCreateAddress(deployer, n + k + 2);
        address migratorAt = vm.computeCreateAddress(deployer, n + k + 3);
        address consolidatorAt = vm.computeCreateAddress(deployer, n + k + 6);
        bytes32 salt = _mineHookSalt(poolManager, migratorAt);
        uint256 fund = vm.envOr("FUND_DEPLOYER", uint256(0));

        vm.startBroadcast(key);
        OmniCurveDeployer curveDeployer = new OmniCurveDeployer(factoryAt);
        vm.stopBroadcast();

        vm.startBroadcast(fkey);
        OmniCoinDeployer coinDeployer = new OmniCoinDeployer(factoryAt);
        OmniFactory factory = new OmniFactory(
            deployer, ILayerZeroEndpointV2(endpoint), localEid, IERC20(usdAt), hubAt, migratorAt, consolidatorAt, treasury,
            rewards, cfg, minDvns, coinDeployer, curveDeployer
        );
        if (fund > 0) {
            // A plain call (not transfer): the deployer may be an EIP-7702 account with code.
            (bool ok,) = deployer.call{value: fund}("");
            require(ok, "top-up failed");
        }
        vm.stopBroadcast();
        require(address(coinDeployer) == coinDeployerAt, "coin deployer address moved");
        require(address(factory) == factoryAt, "factory address moved");
        o.factory = address(factory);

        vm.startBroadcast(key);
        o.usd = mainnet ? realUsd : address(new TestUsdOft(endpoint, deployer));
        o.hub = address(new OmniHub(endpoint, deployer, coordEid, localEid));
        o.bridge = mainnet
            ? address(new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(realUsd), deployer))
            : address(new OftUsdBridge(IOFT(o.usd), endpoint, deployer));
        MigratorV6 migrator = new MigratorV6(
            IPoolManager(poolManager), IPositionManager(positionManager), IAllowanceTransfer(PERMIT2), IERC20(o.usd),
            IHubLocal(o.hub), o.bridge, rewards, 3_000, salt
        );
        o.migrator = address(migrator);
        o.router = address(new UsdPoolRouter(IPoolManager(poolManager), IUsdGraduatedPools(o.migrator)));
        migrator.bindRouter(IV6BuybackRouter(o.router));
        o.consolidator = address(new ConsolidatorV6(IERC20(o.usd), IHubLocal(o.hub), IUsdcBridge(o.bridge)));
        OmniHub(payable(o.hub)).setKeeper(keeper);
        OmniHub(payable(o.hub)).setFactory(o.factory);
        vm.stopBroadcast();
        // The factory was built with these addresses before they existed: check every one.
        require(o.usd == usdAt && o.hub == hubAt && o.bridge == bridgeAt, "address moved (usd/hub/bridge)");
        require(o.migrator == migratorAt && o.consolidator == consolidatorAt, "address moved (migrator/consolidator)");
        require(address(factory.usdc()) == o.usd && factory.hub() == o.hub && factory.migrator() == o.migrator, "factory wiring");
        require(factory.consolidator() == o.consolidator, "factory wiring (consolidator)");

        string memory j = "omni";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "eid", localEid);
        vm.serializeUint(j, "coordEid", coordEid);
        vm.serializeString(j, "bridgeKind", mainnet ? "across" : "oft");
        vm.serializeAddress(j, "usd", o.usd);
        vm.serializeAddress(j, "hub", o.hub);
        vm.serializeAddress(j, "bridge", o.bridge);
        vm.serializeAddress(j, "migrator", o.migrator);
        vm.serializeAddress(j, "hook", address(MigratorV6(o.migrator).hook()));
        vm.serializeAddress(j, "router", o.router);
        vm.serializeAddress(j, "consolidator", o.consolidator);
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "coinDeployer", address(coinDeployer));
        vm.serializeAddress(j, "curveDeployer", address(curveDeployer));
        string memory out = vm.serializeAddress(j, "factory", o.factory);
        vm.writeJson(out, string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/omni/")), vm.toString(block.chainid), ".json"));

        console2.log("--- sasa v6 (omnichain) ---");
        console2.log("Chain id / eid:  ", block.chainid, localEid);
        console2.log("Test USD (OFT):  ", o.usd);
        console2.log("OmniHub:         ", o.hub);
        console2.log("OftUsdBridge:    ", o.bridge);
        console2.log("MigratorV6:      ", o.migrator);
        console2.log("PoolRouter:      ", o.router);
        console2.log("ConsolidatorV6:  ", o.consolidator);
        console2.log("OmniFactory:     ", o.factory, "(same on every chain)");
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
