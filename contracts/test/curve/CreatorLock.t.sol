// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {MockMigrator} from "./NeuronCurve.t.sol";

/// Optional creator lock (v4): the creator's coins can't move until the lock ends.
contract CreatorLockTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address other = makeAddr("other");
    bytes32 constant REPORT = keccak256("tally");

    NeuronCurveFactory factory;

    function setUp() public {
        factory = new NeuronCurveFactory(
            owner,
            new MockMigrator(),
            operator,
            protocol,
            NeuronCurveFactory.Config({
                virtualNative: 1 ether,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 0.5 ether
            })
        );
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
    }

    function _launch(uint256 lock, uint256 firstBuy) internal returns (NeuronCurve c, CurveToken t) {
        vm.prank(creator);
        (address curve,,) = factory.launchLocked{value: firstBuy}("Harbor Cat", "HCAT", "", "", "k", 0, NeuronCurve.FeeMode.Creator, lock);
        c = NeuronCurve(payable(curve));
        t = c.token();
    }

    function _sell(NeuronCurve c, address who, uint256 amount) internal {
        vm.startPrank(who);
        c.token().approve(address(c), amount);
        c.sell(amount, 0, who);
        vm.stopPrank();
    }

    function test_noLock_viaOldLaunch() public {
        vm.prank(creator);
        (address curve,,) = factory.launch{value: 0.1 ether}("A", "A", "", "", "a", 0, NeuronCurve.FeeMode.Creator);
        NeuronCurve c = NeuronCurve(payable(curve));
        assertEq(c.token().lockedUntil(), 0);
        assertEq(c.token().lockedAccount(), address(0));
        _sell(c, creator, c.token().balanceOf(creator)); // sells fine
    }

    function test_lockZero_isNoLock() public {
        (NeuronCurve c, CurveToken t) = _launch(0, 0.1 ether);
        assertEq(t.lockedUntil(), 0);
        _sell(c, creator, t.balanceOf(creator));
    }

    function test_locked_creatorCannotSell() public {
        (NeuronCurve c, CurveToken t) = _launch(1 hours, 0.1 ether);
        uint256 bal = t.balanceOf(creator);
        assertGt(bal, 0, "first buy landed");
        assertEq(t.lockedUntil(), block.timestamp + 1 hours);
        vm.startPrank(creator);
        t.approve(address(c), bal);
        vm.expectRevert(abi.encodeWithSelector(CurveToken.CreatorLocked.selector, block.timestamp + 1 hours));
        c.sell(bal, 0, creator);
        vm.stopPrank();
    }

    function test_locked_creatorCannotMoveCoinsAway() public {
        (, CurveToken t) = _launch(1 days, 0.1 ether);
        uint256 bal = t.balanceOf(creator);
        vm.prank(creator);
        vm.expectRevert();
        t.transfer(other, bal);
        // not through an allowance either
        vm.prank(creator);
        t.approve(other, bal);
        vm.prank(other);
        vm.expectRevert();
        t.transferFrom(creator, other, bal);
    }

    function test_locked_creatorCanStillBuyMore() public {
        (NeuronCurve c, CurveToken t) = _launch(1 hours, 0.1 ether);
        uint256 before = t.balanceOf(creator);
        vm.prank(creator);
        c.buy{value: 0.05 ether}(0, creator);
        assertGt(t.balanceOf(creator), before);
    }

    function test_locked_othersTradeFreely() public {
        (NeuronCurve c, CurveToken t) = _launch(1 days, 0.1 ether);
        vm.prank(alice);
        uint256 got = c.buy{value: 1 ether}(0, alice);
        _sell(c, alice, got / 2);
        vm.prank(alice);
        t.transfer(other, got / 4);
        assertEq(t.balanceOf(other), got / 4);
    }

    function test_unlocksAtExpiry() public {
        (NeuronCurve c, CurveToken t) = _launch(1 hours, 0.1 ether);
        uint256 bal = t.balanceOf(creator);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.startPrank(creator);
        t.approve(address(c), bal);
        vm.expectRevert();
        c.sell(bal, 0, creator);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
        _sell(c, creator, bal);
        assertEq(t.balanceOf(creator), 0);
    }

    function test_lockLongerThanADay_reverts() public {
        vm.prank(creator);
        vm.expectRevert(CurveToken.LockTooLong.selector);
        factory.launchLocked("A", "A", "", "", "a", 0, NeuronCurve.FeeMode.Creator, 1 days + 1);
    }

    function test_lockEvent() public {
        vm.expectEmit(false, false, true, true);
        emit NeuronCurveFactory.CreatorLocked(address(0), address(0), creator, block.timestamp + 1 hours);
        _launch(1 hours, 0);
    }

    function test_graduationUnaffectedByLock() public {
        (NeuronCurve c,) = _launch(1 days, 0.1 ether);
        vm.prank(alice);
        c.buy{value: 1 ether}(0, alice);
        vm.prank(operator);
        c.graduate(REPORT);
        assertEq(uint256(c.state()), uint256(NeuronCurve.State.Graduated));
    }

    function test_lockedCoinsStillEarnHolderRewards() public {
        vm.prank(creator);
        (address curve,,) = factory.launchLocked{value: 0.5 ether}("R", "R", "", "", "r", 0, NeuronCurve.FeeMode.Holders, 1 days);
        NeuronCurve c = NeuronCurve(payable(curve));
        CurveToken t = c.token();
        vm.prank(alice);
        c.buy{value: 2 ether}(0, alice);
        c.claimCreatorFees(); // holders mode: shared among holders
        assertGt(t.claimable(creator), 0, "locked creator still earns");
    }

    function testFuzz_lockWindow(uint32 lock, uint32 later) public {
        uint256 l = bound(lock, 1, 1 days);
        uint256 w = bound(later, 0, 2 days);
        (NeuronCurve c, CurveToken t) = _launch(l, 0.1 ether);
        uint256 bal = t.balanceOf(creator);
        vm.warp(block.timestamp + w);
        vm.startPrank(creator);
        t.approve(address(c), bal);
        if (w < l) vm.expectRevert();
        c.sell(bal, 0, creator);
        vm.stopPrank();
    }
}
