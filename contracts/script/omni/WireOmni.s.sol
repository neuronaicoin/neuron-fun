// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {TestUsdOft} from "../../src/omni/TestUsdOft.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {OmniFactory} from "../../src/omni/OmniFactory.sol";

/**
 * @notice Connects this chain's v6 contracts to the same contracts on the other
 * chains (after DeployOmni ran everywhere). Safe to run again: it only (re)sets links.
 *
 * Env: REMOTE_CHAIN_IDS (comma list, their deployments/omni/<id>.json must exist),
 * and this chain's LayerZero send/receive libraries, executor and verifiers
 * (SEND_LIB, RECEIVE_LIB, EXECUTOR, DVNS comma list), CONFIRMATIONS,
 * LOCK_BRIDGE (true once every chain is in), OPEN_LAUNCHES.
 */
contract WireOmni is Script {
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    struct Local {
        address usd;
        address hub;
        address bridge;
        address migrator;
        address consolidator;
        address factory;
        uint32 eid;
    }

    function _load(uint256 chainId) internal view returns (Local memory l) {
        string memory j = vm.readFile(string.concat("./deployments/omni/", vm.toString(chainId), ".json"));
        l.usd = vm.parseJsonAddress(j, ".usd");
        l.hub = vm.parseJsonAddress(j, ".hub");
        l.bridge = vm.parseJsonAddress(j, ".bridge");
        l.migrator = vm.parseJsonAddress(j, ".migrator");
        l.consolidator = vm.parseJsonAddress(j, ".consolidator");
        l.factory = vm.parseJsonAddress(j, ".factory");
        l.eid = uint32(vm.parseJsonUint(j, ".eid"));
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

        ILayerZeroEndpointV2 ep = OmniFactory(me.factory).endpoint();
        require(ep.eid() == me.eid, "endpoint / eid mismatch");
        bytes memory execCfg = abi.encode(uint32(10_000), executor);
        bytes memory ulnCfg = abi.encode(OmniFactory.UlnConfig(confirmations, uint8(dvns.length), 0, 0, dvns, new address[](0)));

        uint32[] memory eids = new uint32[](remotes.length);
        bytes32[] memory twins = new bytes32[](remotes.length);

        vm.startBroadcast(key);
        for (uint256 i; i < remotes.length; ++i) {
            Local memory r = _load(remotes[i]);
            require(r.factory == me.factory, "factory differs between chains: coins would not share an address");
            OmniHub(payable(me.hub)).setPeer(r.eid, bytes32(uint256(uint160(r.hub))));
            TestUsdOft(me.usd).setPeer(r.eid, bytes32(uint256(uint160(r.usd))));
            _route(ep, me.hub, r.eid, sendLib, receiveLib, execCfg, ulnCfg);
            _route(ep, me.usd, r.eid, sendLib, receiveLib, execCfg, ulnCfg);
            OmniFactory(me.factory).setRoute(r.eid, OmniFactory.Route(sendLib, receiveLib, execCfg, ulnCfg));
            eids[i] = r.eid;
            twins[i] = bytes32(uint256(uint160(r.bridge)));
            console2.log("linked to eid", r.eid);
        }
        OftUsdBridge br = OftUsdBridge(payable(me.bridge));
        if (!br.locked()) {
            br.setup(me.consolidator, me.migrator, eids, twins);
            if (lockBridge) br.lock();
        }
        OmniFactory(me.factory).setLaunchesOpen(openLaunches);
        vm.stopBroadcast();
        console2.log("bridge locked:", br.locked(), " launches open:", openLaunches);
    }

    function _route(
        ILayerZeroEndpointV2 ep,
        address oapp,
        uint32 eid,
        address sendLib,
        address receiveLib,
        bytes memory execCfg,
        bytes memory ulnCfg
    ) internal {
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
