// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {AcrossUsdBridge} from "../../src/omni/AcrossUsdBridge.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";

/**
 * @notice Connects this chain's v7 contracts to the same contracts on the other chains
 * (after DeployRace ran everywhere). Safe to run again: it only (re)sets links.
 * The test dollar's own links (an OFT) were set up with v6 and are not touched.
 *
 * Env: REMOTE_CHAIN_IDS (comma list; their deployments/race/<id>.json must exist), this
 * chain's LayerZero SEND_LIB, RECEIVE_LIB, EXECUTOR, DVNS (comma list, sorted),
 * CONFIRMATIONS, LOCK_BRIDGE (true once every chain is in), OPEN_LAUNCHES.
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

        vm.startBroadcast(key);
        for (uint256 i; i < remotes.length; ++i) {
            Local memory r = _load(remotes[i]);
            require(r.factory == me.factory, "factory differs between chains: coins would not share an address");
            require(r.across == me.across, "every chain must use the same bridge kind");
            OmniHub(payable(me.hub)).setPeer(r.eid, bytes32(uint256(uint160(r.hub))));
            _route(ep, me.hub, r.eid, sendLib, receiveLib, execCfg, ulnCfg);
            RaceFactory(me.factory).setRoute(r.eid, RaceFactory.Route(sendLib, receiveLib, execCfg, ulnCfg));
            eids[i] = r.eid;
            twins[i] = bytes32(uint256(uint160(r.bridge)));
            console2.log("linked to eid", r.eid);
        }
        bool bridgeLocked;
        if (me.across) {
            AcrossUsdBridge ab = AcrossUsdBridge(me.bridge);
            AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](remotes.length);
            for (uint256 i; i < remotes.length; ++i) {
                Local memory r = _load(remotes[i]);
                rs[i] = AcrossUsdBridge.Route(r.chainId, r.usd, r.bridge);
            }
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
        vm.stopBroadcast();
        console2.log("bridge locked:", bridgeLocked, " launches open:", openLaunches);
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
