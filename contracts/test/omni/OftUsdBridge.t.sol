// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IOFT} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {TestUsdOft} from "../../src/omni/TestUsdOft.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";

contract MigStub {
    bytes32 public coin;
    uint256 public amount;
    bool public buyback;
    function receiveConsolidated(bytes32 c, uint256 a, bool b) external {
        coin = c;
        amount = a;
        buyback = b;
    }
}

/// Testnet money route: chain A (lost) sends a coin's money to chain B (won).
contract OftUsdBridgeTest is Test {
    uint32 constant A = 70_001;
    uint32 constant B = 70_002;
    MockLzEndpoint epA;
    MockLzEndpoint epB;
    TestUsdOft usdA;
    TestUsdOft usdB;
    OftUsdBridge brA;
    OftUsdBridge brB;
    MigStub mig;

    function _b(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function setUp() public {
        epA = new MockLzEndpoint(A);
        epB = new MockLzEndpoint(B);
        usdA = new TestUsdOft(address(epA), address(this));
        usdB = new TestUsdOft(address(epB), address(this));
        usdA.setPeer(B, _b(address(usdB)));
        usdB.setPeer(A, _b(address(usdA)));
        brA = new OftUsdBridge(IOFT(address(usdA)), address(epA), address(this));
        brB = new OftUsdBridge(IOFT(address(usdB)), address(epB), address(this));
        mig = new MigStub();
        uint32[] memory e = new uint32[](1);
        bytes32[] memory t = new bytes32[](1);
        e[0] = B;
        t[0] = _b(address(brB));
        brA.setup(address(this), address(0xAAAA), e, t); // this test plays chain A's consolidator
        e[0] = A;
        t[0] = _b(address(brA));
        brB.setup(address(0xBBBB), address(mig), e, t);
        brA.lock();
        brB.lock();
        usdA.faucet(address(this));
        usdA.approve(address(brA), type(uint256).max);
    }

    function test_moneyArrivesTaggedWithItsCoin() public {
        brA.send(B, bytes32("kedi"), 40e6, false, address(this));
        assertEq(usdA.balanceOf(address(this)), 60e6);
        assertEq(usdA.totalSupply(), 60e6); // burned on A...
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
        assertEq(usdB.balanceOf(address(brB)), 40e6); // ...minted on B to the twin bridge
        epB.deliverLastCompose();
        assertEq(usdB.balanceOf(address(mig)), 40e6);
        assertEq(mig.coin(), bytes32("kedi"));
        assertEq(mig.amount(), 40e6);
        assertFalse(mig.buyback());
    }

    function test_buybackFlagTravels() public {
        brA.send(B, bytes32("kedi"), 5e6, true, address(this));
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
        epB.deliverLastCompose();
        assertTrue(mig.buyback());
    }

    function test_onlyConsolidatorSends() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OftUsdBridge.NotConsolidator.selector);
        brA.send(B, bytes32("kedi"), 1e6, false, address(this));
    }

    function test_unknownChainRefused() public {
        vm.expectRevert(OftUsdBridge.UnknownTwin.selector);
        brA.send(99, bytes32("kedi"), 1e6, false, address(this));
    }

    function test_forgedArrivalsRefused() public {
        brA.send(B, bytes32("kedi"), 10e6, false, address(this));
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
        (address from, address to, bytes32 guid, bytes memory m) = epB.composes(0);
        // not the endpoint
        vm.expectRevert(OftUsdBridge.NotEndpoint.selector);
        brB.lzCompose(from, guid, m, address(0), "");
        // through the endpoint, but claiming another token
        vm.prank(address(epB));
        vm.expectRevert(OftUsdBridge.WrongOft.selector);
        brB.lzCompose(address(0xF00), guid, m, address(0), "");
        to;
    }

    function test_setupLocked() public {
        uint32[] memory e = new uint32[](0);
        bytes32[] memory t = new bytes32[](0);
        vm.expectRevert(OftUsdBridge.Locked.selector);
        brA.setup(address(1), address(2), e, t);
    }
}
