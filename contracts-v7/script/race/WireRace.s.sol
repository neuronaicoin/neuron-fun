// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {AcrossUsdBridge} from "../../src/omni/AcrossUsdBridge.sol";
import {AutoOrders} from "../../src/auto/AutoOrders.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";
import {TestUsdV7} from "../../src/race/testnet/TestnetSupport.sol";

interface IMessageLibSupport {
    function isSupportedEid(uint32 eid) external view returns (bool);
}

/**
 * @notice Connects this chain's v7 contracts to the same contracts on the other chains
 * (after DeployRace ran everywhere). Safe to run again: it only (re)sets links.
 * On testnets the v7 test dollar (an OFT) gets its own links here too.
 *
 * Env: REMOTE_CHAIN_IDS (comma list; their deployments/race/<id>.json must exist), this
 * chain's LayerZero SEND_LIB, RECEIVE_LIB, EXECUTOR, DVNS (comma list, sorted),
 * CONFIRMATIONS, LOCK_BRIDGE (true once every chain is in), OPEN_LAUNCHES.
 * Across only: ACROSS_HOP_FOR (comma list of remote chain ids Across has no dollar route to;
 * money for them goes through ACROSS_HOP_CHAIN_ID, which must be a remote with direct routes
 * to both). Mainnet: on BNB Chain ACROSS_HOP_FOR=4663, on Robinhood Chain ACROSS_HOP_FOR=56,
 * ACROSS_HOP_CHAIN_ID=8453 (Base) on both.
 */
contract WireRace is Script {
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    struct Local {
        address usd;
        address hub;
        address bridge;
        address builder;
        address consolidator;
        address factory;
        uint32 eid;
        uint256 chainId;
        bool across;
        bool usdIsTest;
        uint8 usdDecimals;
        address cross;
        address autoOrders;
    }

    function _load(uint256 chainId) internal view returns (Local memory l) {
        string memory j = vm.readFile(string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/race/")), vm.toString(chainId), ".json"));
        l.usd = vm.parseJsonAddress(j, ".usd");
        l.hub = vm.parseJsonAddress(j, ".hub");
        l.bridge = vm.parseJsonAddress(j, ".bridge");
        l.builder = vm.parseJsonAddress(j, ".builder");
        l.consolidator = vm.parseJsonAddress(j, ".consolidator");
        l.factory = vm.parseJsonAddress(j, ".factory");
        l.eid = uint32(vm.parseJsonUint(j, ".eid"));
        l.chainId = vm.parseJsonUint(j, ".chainId");
        l.across = keccak256(bytes(vm.parseJsonString(j, ".bridgeKind"))) == keccak256("across");
        l.usdIsTest = vm.keyExistsJson(j, ".usdIsTest") && vm.parseJsonBool(j, ".usdIsTest");
        // files written before decimals were recorded are 6-decimal dollars (testnets, Base, Robinhood)
        l.usdDecimals = vm.keyExistsJson(j, ".usdDecimals") ? uint8(vm.parseJsonUint(j, ".usdDecimals")) : 6;
        l.cross = vm.keyExistsJson(j, ".cross") ? vm.parseJsonAddress(j, ".cross") : address(0);
        l.autoOrders = vm.keyExistsJson(j, ".autoOrders") ? vm.parseJsonAddress(j, ".autoOrders") : address(0);
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        Local memory me = _load(block.chainid);
        uint256[] memory remotes = vm.envUint("REMOTE_CHAIN_IDS", ",");
        address sendLib = vm.envAddress("SEND_LIB");
        address receiveLib = vm.envAddress("RECEIVE_LIB");
        address executor = vm.envAddress("EXECUTOR");
        address[] memory dvns = vm.envAddress("DVNS", ",");
        uint64 confirmations = uint64(vm.envOr("CONFIRMATIONS", uint256(2)));
        bool lockBridge = vm.envOr("LOCK_BRIDGE", false);
        bool openLaunches = vm.envOr("OPEN_LAUNCHES", true);
        for (uint256 i = 1; i < dvns.length; ++i) require(dvns[i] > dvns[i - 1], "DVNS must be sorted, no repeats");

        ILayerZeroEndpointV2 ep = RaceFactory(me.factory).endpoint();
        require(ep.eid() == me.eid, "endpoint / eid mismatch");
        bytes memory execCfg = abi.encode(uint32(10_000), executor);
        bytes memory ulnCfg = abi.encode(RaceFactory.UlnConfig(confirmations, uint8(dvns.length), 0, 0, dvns, new address[](0)));

        uint32[] memory eids = new uint32[](remotes.length);
        bytes32[] memory twins = new bytes32[](remotes.length);

        // LayerZero must have a path from this chain to every remote (on testnets some pairs are
        // missing; ALLOW_MISSING_ROUTES=true skips those with a warning, never on mainnet)
        bool allowMissing = vm.envOr("ALLOW_MISSING_ROUTES", false);
        uint256 linked;
        vm.startBroadcast(key);
        for (uint256 i; i < remotes.length; ++i) {
            Local memory r = _load(remotes[i]);
            require(r.factory == me.factory, "factory differs between chains: coins would not share an address");
            require(r.across == me.across, "every chain must use the same bridge kind");
            if (!IMessageLibSupport(sendLib).isSupportedEid(r.eid) || !IMessageLibSupport(receiveLib).isSupportedEid(r.eid)) {
                require(allowMissing, string.concat("LayerZero has no path from this chain to eid ", vm.toString(r.eid)));
                console2.log("WARNING: LayerZero has no path to eid", r.eid, "- skipped (coins can't race between these two chains)");
                continue;
            }
            linked++;
            OmniHub(payable(me.hub)).setPeer(r.eid, bytes32(uint256(uint160(r.hub))));
            _route(ep, me.hub, r.eid, sendLib, receiveLib, execCfg, ulnCfg);
            if (me.usdIsTest) {
                // Testnet: the v7 test dollar is itself an OFT and needs its own LayerZero link.
                require(r.usdIsTest, "every testnet must use the v7 test dollar");
                TestUsdV7(me.usd).setPeer(r.eid, bytes32(uint256(uint160(r.usd))));
                _route(ep, me.usd, r.eid, sendLib, receiveLib, execCfg, ulnCfg);
            }
            RaceFactory(me.factory).setRoute(r.eid, RaceFactory.Route(sendLib, receiveLib, execCfg, ulnCfg));
            eids[linked - 1] = r.eid;
            twins[linked - 1] = bytes32(uint256(uint160(r.bridge)));
            console2.log("linked to eid", r.eid);
        }
        require(linked > 0, "no remote chain reachable");
        // drop the skipped remotes from the bridge's lists
        if (linked < remotes.length) (eids, twins) = _trim(eids, twins, linked);
        bool bridgeLocked;
        if (me.across) {
            AcrossUsdBridge ab = AcrossUsdBridge(me.bridge);
            // unset or empty: every route is direct
            uint256[] memory hopFor = bytes(vm.envOr("ACROSS_HOP_FOR", string(""))).length > 0 ? vm.envUint("ACROSS_HOP_FOR", ",") : new uint256[](0);
            Local[] memory all = new Local[](remotes.length);
            for (uint256 k; k < remotes.length; ++k) all[k] = _load(remotes[k]);
            AcrossUsdBridge.Route[] memory rs = acrossRoutes(all, eids, hopFor, vm.envOr("ACROSS_HOP_CHAIN_ID", uint256(0)));
            if (!ab.locked()) {
                ab.setup(me.consolidator, me.builder, eids, rs);
                if (lockBridge) ab.lock();
            }
            bridgeLocked = ab.locked();
        } else {
            OftUsdBridge br = OftUsdBridge(payable(me.bridge));
            if (!br.locked()) {
                br.setup(me.consolidator, me.builder, eids, twins);
                if (lockBridge) br.lock();
            }
            bridgeLocked = br.locked();
        }
        RaceFactory(me.factory).setLaunchesOpen(openLaunches);
        // home chain: dip buys for race coins on the other chains go to their RaceCross (set once)
        if (me.autoOrders != address(0)) {
            AutoOrders ao = AutoOrders(me.autoOrders);
            for (uint256 k; k < remotes.length; ++k) {
                Local memory r = _load(remotes[k]);
                if (r.cross == address(0) || ao.crossRouteOf(r.chainId).raceCross != address(0)) continue;
                if (ao.homeChainId() != block.chainid) continue; // only the home chain buys elsewhere
                ao.setCrossRoute(r.chainId, AutoOrders.CrossRoute(r.cross, r.usd, r.usdDecimals, (30 * 10 ** r.usdDecimals) / 100));
                console2.log("auto orders: dip buys to chain", r.chainId);
            }
        }
        vm.stopBroadcast();
        console2.log("bridge locked:", bridgeLocked, " launches open:", openLaunches);
    }

    /// @notice One Across route per linked chain, in the same order as `eids`; chains in
    /// `hopFor` go through `hopChain`. `remotes` are the other chains' deployment files.
    /// Public so the tests can check it.
    function acrossRoutes(Local[] memory remotes, uint32[] memory eids, uint256[] memory hopFor, uint256 hopChain)
        public
        view
        returns (AcrossUsdBridge.Route[] memory rs)
    {
        for (uint256 i; i < hopFor.length; ++i) require(_find(remotes, hopFor[i]) < remotes.length, "ACROSS_HOP_FOR lists a chain not in REMOTE_CHAIN_IDS");
        rs = new AcrossUsdBridge.Route[](eids.length);
        for (uint256 i; i < eids.length; ++i) {
            for (uint256 k; k < remotes.length; ++k) {
                Local memory r = remotes[k];
                if (r.eid != eids[i]) continue;
                if (_has(hopFor, r.chainId)) {
                    require(hopChain != 0 && hopChain != r.chainId && hopChain != block.chainid, "ACROSS_HOP_CHAIN_ID must be a third chain");
                    uint256 hk = _find(remotes, hopChain);
                    require(hk < remotes.length, "ACROSS_HOP_CHAIN_ID must be one of REMOTE_CHAIN_IDS");
                    Local memory h = remotes[hk];
                    rs[i] = AcrossUsdBridge.Route(h.chainId, h.usd, h.bridge, h.usdDecimals, true);
                    console2.log("two-step route to chain", r.chainId, "through chain", hopChain);
                } else {
                    rs[i] = AcrossUsdBridge.Route(r.chainId, r.usd, r.bridge, r.usdDecimals, false);
                }
            }
            require(rs[i].twin != address(0), "route for a linked chain not found");
        }
    }

    function _find(Local[] memory list, uint256 chainId) internal pure returns (uint256) {
        for (uint256 i; i < list.length; ++i) if (list[i].chainId == chainId) return i;
        return type(uint256).max;
    }

    function _has(uint256[] memory list, uint256 v) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) if (list[i] == v) return true;
        return false;
    }

    function _trim(uint32[] memory a, bytes32[] memory b, uint256 n) internal pure returns (uint32[] memory, bytes32[] memory) {
        uint32[] memory a2 = new uint32[](n);
        bytes32[] memory b2 = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            a2[i] = a[i];
            b2[i] = b[i];
        }
        return (a2, b2);
    }

    function _route(ILayerZeroEndpointV2 ep, address oapp, uint32 eid, address sendLib, address receiveLib, bytes memory execCfg, bytes memory ulnCfg)
        internal
    {
        ep.setSendLibrary(oapp, eid, sendLib);
        ep.setReceiveLibrary(oapp, eid, receiveLib, 0);
        SetConfigParam[] memory s = new SetConfigParam[](2);
        s[0] = SetConfigParam(eid, CONFIG_TYPE_EXECUTOR, execCfg);
        s[1] = SetConfigParam(eid, CONFIG_TYPE_ULN, ulnCfg);
        ep.setConfig(oapp, sendLib, s);
        SetConfigParam[] memory rc = new SetConfigParam[](1);
        rc[0] = SetConfigParam(eid, CONFIG_TYPE_ULN, ulnCfg);
        ep.setConfig(oapp, receiveLib, rc);
    }
}
