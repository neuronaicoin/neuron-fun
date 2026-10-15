// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WireRace} from "../script/race/WireRace.s.sol";
import {AcrossUsdBridge} from "../src/omni/AcrossUsdBridge.sol";
import {DecUsd} from "./AcrossUsdBridge.t.sol";
import {ChainSpoke} from "./AcrossHop.t.sol";

/// The mainnet Across wiring: the routes WireRace builds from the deployment files, and that a
/// bridge accepts them. BNB Chain and Robinhood Chain reach each other through Base.
contract WireRoutesTest is Test {
    uint256 constant BASE = 8453;
    uint256 constant BNB = 56;
    uint256 constant HOOD = 4663;
    uint256 constant ARC = 5042;

    function _eid(uint256 chainId) internal pure returns (uint32) {
        if (chainId == BASE) return 30184;
        if (chainId == BNB) return 30102;
        if (chainId == HOOD) return 30416;
        return 30417;
    }

    function _usd(uint256 chainId) internal pure returns (address) {
        return address(uint160(0xD0000 + chainId));
    }

    function _bridge(uint256 chainId) internal pure returns (address) {
        return address(uint160(0xB0000 + chainId));
    }

    function _local(uint256 chainId, uint8 dec) internal pure returns (WireRace.Local memory l) {
        l.chainId = chainId;
        l.eid = _eid(chainId);
        l.usd = _usd(chainId);
        l.usdDecimals = dec;
        l.bridge = _bridge(chainId);
        l.across = true;
    }

    function _dec(uint256 chainId) internal pure returns (uint8) {
        return chainId == BNB ? 18 : 6;
    }

    function _others(uint256 me) internal pure returns (WireRace.Local[] memory r, uint32[] memory e) {
        uint256[4] memory all = [BASE, BNB, HOOD, ARC];
        r = new WireRace.Local[](3);
        e = new uint32[](3);
        uint256 n;
        for (uint256 i; i < 4; ++i) {
            if (all[i] == me) continue;
            r[n] = _local(all[i], _dec(all[i]));
            e[n] = _eid(all[i]);
            n++;
        }
    }

    function _list(uint256 a) internal pure returns (uint256[] memory l) {
        l = new uint256[](1);
        l[0] = a;
    }

    /// The routes, and a real bridge on this chain accepting them.
    function _check(uint256 me, uint8 dec, uint256[] memory hopFor, uint256 hopChain) internal returns (AcrossUsdBridge.Route[] memory rs) {
        vm.chainId(me);
        (WireRace.Local[] memory remotes, uint32[] memory eids) = _others(me);
        rs = new WireRace().acrossRoutes(remotes, eids, hopFor, hopChain);
        AcrossUsdBridge b = new AcrossUsdBridge(new ChainSpoke(), IERC20(address(new DecUsd(dec))), address(this));
        b.setup(address(4), address(3), eids, rs);
    }

    function test_bnbReachesRobinhoodThroughBase() public {
        AcrossUsdBridge.Route[] memory rs = _check(BNB, 18, _list(HOOD), BASE);
        // remotes order: Base, Robinhood, Arc
        assertEq(rs[0].chainId, BASE);
        assertFalse(rs[0].viaHop);
        assertEq(rs[0].outputDecimals, 6);
        assertEq(rs[1].chainId, BASE, "Robinhood goes to Base first");
        assertEq(rs[1].twin, _bridge(BASE));
        assertEq(rs[1].outputToken, _usd(BASE));
        assertEq(rs[1].outputDecimals, 6);
        assertTrue(rs[1].viaHop);
        assertEq(rs[2].chainId, ARC);
        assertFalse(rs[2].viaHop);
    }

    function test_robinhoodReachesBnbThroughBase() public {
        AcrossUsdBridge.Route[] memory rs = _check(HOOD, 6, _list(BNB), BASE);
        // remotes order: Base, BNB Chain, Arc
        assertFalse(rs[0].viaHop);
        assertEq(rs[1].chainId, BASE, "BNB Chain goes to Base first");
        assertTrue(rs[1].viaHop);
        assertFalse(rs[2].viaHop);
    }

    /// Base and Arc reach every chain directly; their routes carry each chain's decimals.
    function test_baseAndArcAllDirect() public {
        AcrossUsdBridge.Route[] memory rs = _check(BASE, 6, new uint256[](0), 0);
        for (uint256 i; i < 3; ++i) assertFalse(rs[i].viaHop);
        assertEq(rs[0].chainId, BNB);
        assertEq(rs[0].outputDecimals, 18);
        assertEq(rs[0].twin, _bridge(BNB));
        rs = _check(ARC, 6, new uint256[](0), 0);
        for (uint256 i; i < 3; ++i) assertFalse(rs[i].viaHop);
    }

    function test_hopNeedsThirdChain() public {
        vm.chainId(BNB);
        (WireRace.Local[] memory remotes, uint32[] memory eids) = _others(BNB);
        WireRace w = new WireRace();
        vm.expectRevert(bytes("ACROSS_HOP_CHAIN_ID must be a third chain"));
        w.acrossRoutes(remotes, eids, _list(HOOD), 0);
        vm.expectRevert(bytes("ACROSS_HOP_CHAIN_ID must be a third chain"));
        w.acrossRoutes(remotes, eids, _list(HOOD), HOOD);
        vm.expectRevert(bytes("ACROSS_HOP_CHAIN_ID must be a third chain"));
        w.acrossRoutes(remotes, eids, _list(HOOD), BNB);
    }

    function test_hopForMustBeARemote() public {
        vm.chainId(BNB);
        (WireRace.Local[] memory remotes, uint32[] memory eids) = _others(BNB);
        WireRace w = new WireRace();
        vm.expectRevert(bytes("ACROSS_HOP_FOR lists a chain not in REMOTE_CHAIN_IDS"));
        w.acrossRoutes(remotes, eids, _list(1), BASE);
    }
}
