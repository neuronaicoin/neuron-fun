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
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../../src/omni/ConsolidatorV6.sol";
import {OmniCoinDeployer} from "../../src/omni/OmniDeployers.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../../src/usd/UsdPoolRouter.sol";
import {RaceBuilder} from "../../src/race/RaceBuilder.sol";
import {RaceLaunchHook} from "../../src/race/RaceLaunchHook.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";

/**
 * @notice sasa v7 (five-minute race) on ONE chain. Run it on every chain first, then
 * WireRace on every chain. Writes the addresses to deployments/race/<chainid>.json.
 *
 * Two keys:
 *  - PRIVATE_KEY: the deployer (hub, bridge, builder, consolidator, router, wiring).
 *  - RACE_FACTORY_KEY: a NEW wallet used for exactly two transactions per chain: nonce 0
 *    deploys the coin deployer, nonce 1 the factory. Same key + same nonces = the same
 *    factory address on every chain = every coin at the same address on every chain.
 *
 * The dollar: USD_TOKEN. On testnets: the existing test dollar (an OFT, so the dollar
 * bridge is the OFT one). On mainnets: the chain's dollar plus ACROSS_SPOKE.
 */
contract DeployRace is Script {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct Out {
        address hub;
        address bridge;
        address builder;
        address consolidator;
        address router;
        address factory;
        address coinDeployer;
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        uint256 fkey = vm.envUint("RACE_FACTORY_KEY");
        address deployer = vm.addr(key);
        address fdeployer = vm.addr(fkey);
        address endpoint = vm.envAddress("LZ_ENDPOINT");
        uint32 localEid = uint32(vm.envUint("LOCAL_EID"));
        uint32 coordEid = uint32(vm.envUint("COORD_EID"));
        address usd = vm.envAddress("USD_TOKEN");
        address spoke = vm.envOr("ACROSS_SPOKE", address(0));
        bool across = spoke != address(0);
        address treasury = vm.envOr("TREASURY", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address owner = vm.envOr("ADMIN", deployer);
        uint8 minDvns = uint8(vm.envOr("MIN_DVNS", uint256(1)));
        uint256 startMc = vm.envOr("START_MC", uint256(3_000e6));
        uint256 minFirstBuy = vm.envOr("MIN_FIRST_BUY", uint256(5e6));
        address poolManager = vm.envAddress("POOL_MANAGER");
        address positionManager = vm.envAddress("POSITION_MANAGER");

        require(ILayerZeroEndpointV2(endpoint).eid() == localEid, "LZ endpoint is not the one for LOCAL_EID");
        require(usd.code.length > 0, "USD_TOKEN has no code on this chain");
        require(PERMIT2.code.length > 0 && poolManager.code.length > 0 && positionManager.code.length > 0, "Uniswap v4 missing here");
        if (across) require(spoke.code.length > 0, "ACROSS_SPOKE has no code on this chain");
        require(fdeployer != deployer, "RACE_FACTORY_KEY must be a separate wallet");
        require(vm.getNonce(fdeployer) == 0, "RACE_FACTORY_KEY wallet was used before: needs nonce 0 on every chain");
        address coinDeployerAt = vm.computeCreateAddress(fdeployer, 0);
        address factoryAt = vm.computeCreateAddress(fdeployer, 1);
        require(factoryAt.code.length == 0, "factory already deployed here");

        uint64 n = vm.getNonce(deployer);
        address hubAt = vm.computeCreateAddress(deployer, n);
        address bridgeAt = vm.computeCreateAddress(deployer, n + 1);
        address builderAt = vm.computeCreateAddress(deployer, n + 2);
        address consolidatorAt = vm.computeCreateAddress(deployer, n + 3);
        address routerAt = vm.computeCreateAddress(deployer, n + 4);
        bytes32 salt = _mineHookSalt(poolManager, builderAt);
        uint256 fund = vm.envOr("FUND_DEPLOYER", uint256(0));

        Out memory o;
        vm.startBroadcast(fkey);
        OmniCoinDeployer coinDeployer = new OmniCoinDeployer(factoryAt);
        RaceFactory factory = new RaceFactory(
            deployer, ILayerZeroEndpointV2(endpoint), localEid, IERC20(usd), hubAt, builderAt, treasury, minDvns, coinDeployer,
            startMc, minFirstBuy, 10
        );
        if (fund > 0) {
            (bool ok,) = deployer.call{value: fund}("");
            require(ok, "top-up failed");
        }
        vm.stopBroadcast();
        require(address(coinDeployer) == coinDeployerAt && address(factory) == factoryAt, "factory address moved");
        o.factory = address(factory);
        o.coinDeployer = address(coinDeployer);

        vm.startBroadcast(key);
        o.hub = address(new OmniHub(endpoint, deployer, coordEid, localEid));
        o.bridge = across
            ? address(new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(usd), deployer))
            : address(new OftUsdBridge(IOFT(usd), endpoint, deployer));
        RaceBuilder builder = new RaceBuilder(
            IPoolManager(poolManager), IPositionManager(positionManager), IAllowanceTransfer(PERMIT2), IERC20(usd), treasury, salt
        );
        o.builder = address(builder);
        o.consolidator = address(new ConsolidatorV6(IERC20(usd), IHubLocal(o.hub), IUsdcBridge(o.bridge)));
        o.router = address(new UsdPoolRouter(IPoolManager(poolManager), IUsdGraduatedPools(o.builder)));
        builder.bind(o.factory, o.consolidator, o.bridge);
        OmniHub(payable(o.hub)).setKeeper(keeper);
        OmniHub(payable(o.hub)).setFactory(o.factory);
        if (owner != deployer) factory.transferOwnership(owner);
        vm.stopBroadcast();

        require(o.hub == hubAt && o.bridge == bridgeAt && o.builder == builderAt, "address moved (hub/bridge/builder)");
        require(o.consolidator == consolidatorAt && o.router == routerAt, "address moved (consolidator/router)");
        require(factory.hub() == o.hub && factory.builder() == o.builder && address(factory.usdc()) == usd, "factory wiring");
        require(builder.factory() == o.factory && builder.consolidator() == o.consolidator && builder.bridge() == o.bridge, "builder wiring");

        string memory j = "race";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "eid", localEid);
        vm.serializeUint(j, "coordEid", coordEid);
        vm.serializeString(j, "bridgeKind", across ? "across" : "oft");
        vm.serializeAddress(j, "usd", usd);
        vm.serializeAddress(j, "hub", o.hub);
        vm.serializeAddress(j, "bridge", o.bridge);
        vm.serializeAddress(j, "builder", o.builder);
        vm.serializeAddress(j, "hook", address(builder.hook()));
        vm.serializeAddress(j, "consolidator", o.consolidator);
        vm.serializeAddress(j, "router", o.router);
        vm.serializeAddress(j, "coinDeployer", o.coinDeployer);
        vm.serializeUint(j, "startMarketCap", startMc);
        vm.serializeUint(j, "minFirstBuy", minFirstBuy);
        vm.serializeUint(j, "startBlock", block.number);
        string memory out = vm.serializeAddress(j, "factory", o.factory);
        vm.writeJson(out, string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/race/")), vm.toString(block.chainid), ".json"));
        console2.log("--- sasa v7 (race) ---");
        console2.log("Chain id / eid: ", block.chainid, localEid);
        console2.log("OmniHub:        ", o.hub);
        console2.log("Dollar bridge:  ", o.bridge);
        console2.log("RaceBuilder:    ", o.builder);
        console2.log("Consolidator:   ", o.consolidator);
        console2.log("Router:         ", o.router);
        console2.log("RaceFactory:    ", o.factory, "(same on every chain)");
    }

    function _mineHookSalt(address poolManager, address builderAddr) internal pure returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(RaceLaunchHook).creationCode, abi.encode(poolManager, builderAddr)));
        uint160 want = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        for (uint256 i; i < 2_000_000; ++i) {
            address h = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), builderAddr, bytes32(i), initHash)))));
            if (uint160(h) & Hooks.ALL_HOOK_MASK == want) return bytes32(i);
        }
        revert("no hook salt found");
    }
}
