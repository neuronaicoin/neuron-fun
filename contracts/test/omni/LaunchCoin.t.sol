// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {SendParam} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";

contract LaunchCoinTest is Test {
    uint32 constant A = 30_001; // losing chain
    uint32 constant B = 30_002; // winning chain
    MockLzEndpoint epA;
    MockLzEndpoint epB;
    LaunchCoin coinA;
    LaunchCoin coinB;
    address ctrl = address(0xC0);
    address treasury = address(0x7E);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address creatorAddr = address(0xC4EA);

    function setUp() public {
        epA = new MockLzEndpoint(A);
        epB = new MockLzEndpoint(B);
        coinA = new LaunchCoin("Kedi", "KEDI", address(epA), 10, treasury, creatorAddr, 0, address(this));
        coinB = new LaunchCoin("Kedi", "KEDI", address(epB), 10, treasury, creatorAddr, 0, address(this));
        coinA.setPeer(B, bytes32(uint256(uint160(address(coinB)))));
        coinB.setPeer(A, bytes32(uint256(uint160(address(coinA)))));
        coinA.setController(ctrl);
        coinB.setController(ctrl);
        coinA.renounceOwnership();
        coinB.renounceOwnership();
    }

    function _deliverLast() internal {
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
    }

    function test_onlyControllerMints_andCap() public {
        vm.expectRevert(LaunchCoin.NotController.selector);
        coinA.mint(alice, 1);
        vm.startPrank(ctrl);
        coinA.mint(alice, 1_000_000_000 ether);
        vm.expectRevert(LaunchCoin.OverCap.selector);
        coinA.mint(alice, 1);
        vm.stopPrank();
    }

    function test_setupIsOneTime_andOwnerGone() public {
        vm.expectRevert();
        coinA.setController(address(1));
        vm.expectRevert();
        coinA.setPeer(B, bytes32(uint256(1)));
        assertEq(coinA.owner(), address(0));
    }

    function test_noBridgeBeforeGraduation() public {
        vm.prank(ctrl);
        coinA.mint(alice, 100 ether);
        SendParam memory p = SendParam(B, bytes32(uint256(uint160(alice))), 10 ether, 0, "", "", "");
        vm.prank(alice);
        vm.expectRevert(LaunchCoin.BridgeClosed.selector);
        coinA.send(p, MessagingFee(0, 0), alice);
        vm.expectRevert(LaunchCoin.BridgeClosed.selector);
        address[] memory hs = new address[](1);
        hs[0] = alice;
        coinA.moveBatch(hs, "");
    }

    function test_openBridgeOnce() public {
        vm.startPrank(ctrl);
        coinA.openBridge(B);
        vm.expectRevert(LaunchCoin.AlreadySet.selector);
        coinA.openBridge(A);
        vm.stopPrank();
        assertEq(coinA.homeEid(), B);
    }

    function test_moveBatch_sameAddress_withFee() public {
        vm.startPrank(ctrl);
        coinA.mint(alice, 1000 ether);
        coinA.mint(bob, 500 ether);
        coinA.openBridge(B);
        coinB.openBridge(B);
        vm.stopPrank();

        address[] memory hs = new address[](3);
        hs[0] = alice;
        hs[1] = bob;
        hs[2] = address(0xE0A); // empty balance: skipped
        vm.prank(address(0xBEEF)); // anyone can trigger
        vm.warp(block.timestamp + 24 hours); // public moves open a day after graduation
        coinA.moveBatch(hs, "");
        assertEq(coinA.balanceOf(alice), 0);
        assertEq(coinA.balanceOf(bob), 0);
        assertEq(coinA.totalSupply(), 0);

        _deliverLast();
        assertEq(coinB.balanceOf(alice), 999 ether); // 0.1% fee
        assertEq(coinB.balanceOf(bob), 499.5 ether);
        assertEq(coinB.balanceOf(treasury), 1.5 ether);
        assertEq(coinB.totalSupply(), 1500 ether); // nothing created or lost
    }

    function test_moveBatch_skipsNothingForContracts_reverts() public {
        vm.startPrank(ctrl);
        coinA.mint(address(this), 10 ether); // this test contract = a contract wallet
        coinA.openBridge(B);
        vm.stopPrank();
        address[] memory hs = new address[](1);
        hs[0] = address(this);
        vm.expectRevert(abi.encodeWithSelector(LaunchCoin.NotPlainAccount.selector, address(this)));
        vm.warp(block.timestamp + 24 hours); // public moves open a day after graduation
        coinA.moveBatch(hs, "");
    }

    function test_eip7702AccountIsPlain() public {
        address eoa = address(0x7702);
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(0x1234)));
        assertTrue(coinA.isPlainAccount(eoa));
        assertTrue(coinA.isPlainAccount(alice));
        assertFalse(coinA.isPlainAccount(address(coinB)));
    }

    function test_winnerCannotMoveBatch() public {
        vm.startPrank(ctrl);
        coinB.mint(alice, 1 ether);
        coinB.openBridge(B);
        vm.stopPrank();
        address[] memory hs = new address[](1);
        hs[0] = alice;
        vm.expectRevert(LaunchCoin.NotLosingChain.selector);
        coinB.moveBatch(hs, "");
    }

    function test_normalSendAfterGraduation() public {
        vm.startPrank(ctrl);
        coinA.mint(address(this), 100 ether);
        coinA.openBridge(B);
        vm.stopPrank();
        SendParam memory p = SendParam(B, bytes32(uint256(uint160(address(this)))), 40 ether, 40 ether, "", "", "");
        coinA.send(p, MessagingFee(0, 0), address(this));
        _deliverLast();
        assertEq(coinB.balanceOf(address(this)), 40 ether);
        assertEq(coinA.balanceOf(address(this)), 60 ether);
    }

    function test_onlyPeerCanDeliver() public {
        // A message claiming to come from a stranger on chain A is refused.
        MockLzEndpoint.Packet memory fake =
            MockLzEndpoint.Packet(A, address(0xBAD), B, bytes32(uint256(uint160(address(coinB)))), abi.encodePacked(bytes32(uint256(uint160(alice))), uint64(1e6)));
        vm.expectRevert();
        epB.deliver(fake);
    }

    function testFuzz_moveConservesSupply(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1 ether, 400_000_000 ether));
        b = uint96(bound(b, 1 ether, 400_000_000 ether));
        vm.startPrank(ctrl);
        coinA.mint(alice, a);
        coinA.mint(bob, b);
        coinA.openBridge(B);
        vm.stopPrank();
        uint256 before = coinA.totalSupply();
        address[] memory hs = new address[](2);
        hs[0] = alice;
        hs[1] = bob;
        vm.warp(block.timestamp + 24 hours); // public moves open a day after graduation
        coinA.moveBatch(hs, "");
        _deliverLast();
        // Only dust below 1e-6 coin may stay behind; nothing is ever created.
        assertLe(coinB.totalSupply() + coinA.totalSupply(), before);
        assertLt(before - coinB.totalSupply() - coinA.totalSupply(), 1);
        assertLt(coinA.totalSupply(), 2e12);
    }

    function test_creatorLock() public {
        MockLzEndpoint ep = new MockLzEndpoint(9);
        LaunchCoin c = new LaunchCoin("L", "L", address(ep), 10, treasury, creatorAddr, 1 hours, address(this));
        c.setController(ctrl);
        vm.prank(ctrl);
        c.mint(creatorAddr, 100 ether);
        vm.prank(ctrl);
        c.mint(alice, 100 ether);
        uint256 until = c.lockedUntil();
        vm.prank(creatorAddr);
        vm.expectRevert(abi.encodeWithSelector(LaunchCoin.CreatorLocked.selector, until));
        c.transfer(bob, 1 ether);
        vm.prank(alice);
        c.transfer(bob, 1 ether); // others are free
        vm.prank(ctrl);
        c.mint(creatorAddr, 1 ether); // buying more is fine
        vm.warp(block.timestamp + 1 hours);
        vm.prank(creatorAddr);
        c.transfer(bob, 1 ether);
        assertEq(c.balanceOf(bob), 2 ether);
    }

    function test_lockAtMostOneDay() public {
        MockLzEndpoint ep = new MockLzEndpoint(9);
        vm.expectRevert(LaunchCoin.BadFee.selector);
        new LaunchCoin("L", "L", address(ep), 10, treasury, creatorAddr, 1 days + 1, address(this));
    }

    function test_moveBatch_keeperOnlyFirstDay_thenAnyone_moveSelfAnytime() public {
        KeeperHubStub hub = new KeeperHubStub(address(0xBEE));
        CurveHubStub curve = new CurveHubStub(address(hub));
        LaunchCoin c = new LaunchCoin("Kedi", "KEDI", address(epA), 10, treasury, creatorAddr, 0, address(this));
        c.setPeer(B, bytes32(uint256(uint160(address(coinB)))));
        c.setController(address(curve));
        vm.startPrank(address(curve));
        c.mint(alice, 1_000 ether);
        c.mint(bob, 1_000 ether);
        c.mint(carol, 5 ether);
        c.openBridge(B);
        vm.stopPrank();
        address[] memory hs = new address[](1);
        hs[0] = alice;
        // A stranger can't move alice during the first day.
        vm.prank(address(0x5757));
        vm.expectRevert(LaunchCoin.MoveNotOpenYet.selector);
        c.moveBatch(hs, "");
        // sasa's keeper can.
        vm.prank(address(0xBEE));
        c.moveBatch(hs, "");
        assertEq(c.balanceOf(alice), 0);
        // bob moves himself whenever he likes.
        vm.prank(bob);
        c.moveSelf("");
        assertEq(c.balanceOf(bob), 0);
        // After a day anyone may (liveness if the keeper stops).
        hs[0] = carol;
        vm.warp(block.timestamp + 24 hours);
        vm.prank(address(0x5757));
        c.moveBatch(hs, "");
        assertEq(c.balanceOf(carol), 0);
    }

}


contract KeeperHubStub {
    address public keeper;
    constructor(address k) { keeper = k; }
}

contract CurveHubStub {
    address public hub;
    constructor(address h) { hub = h; }
}
