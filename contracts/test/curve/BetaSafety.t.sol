// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {MockMigrator} from "./NeuronCurve.t.sol";

/// Beta safety locks: pause, total cap, guardian, Safe ownership.
contract BetaSafetyTest is Test {
    address owner = makeAddr("owner");
    address safe = makeAddr("safe");
    address guardian = makeAddr("guardian");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 constant REPORT = keccak256("tally");

    MockMigrator migrator;
    NeuronCurveFactory factory;

    function setUp() public {
        migrator = new MockMigrator();
        factory = new NeuronCurveFactory(
            owner,
            migrator,
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
        vm.startPrank(owner);
        factory.setLaunchesOpen(true);
        factory.setGuardian(guardian);
        vm.stopPrank();
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _launch(bytes32 k) internal returns (NeuronCurve c) {
        vm.prank(creator);
        (address curve,,) = factory.launch("Harbor Cat", "HCAT", "", "", k, 0, NeuronCurve.FeeMode.Creator);
        c = NeuronCurve(payable(curve));
    }

    function _buy(NeuronCurve c, address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return c.buy{value: amount}(0, who);
    }

    function _sell(NeuronCurve c, address who, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(who);
        c.token().approve(address(c), amount);
        out = c.sell(amount, 0, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ defaults

    function test_defaults_noCapNotPaused() public view {
        assertEq(factory.nativeCap(), 0);
        assertFalse(factory.buysPaused());
        assertEq(factory.capRoom(), type(uint256).max);
    }

    // ------------------------------------------------------------ pause

    function test_guardianPauses_buysAndLaunchesStop() public {
        NeuronCurve c = _launch("a");
        vm.prank(guardian);
        factory.pauseBuys();

        vm.prank(alice);
        vm.expectRevert(NeuronCurve.BuysPaused.selector);
        c.buy{value: 1 ether}(0, alice);

        vm.prank(creator);
        vm.expectRevert(NeuronCurveFactory.BuysPaused.selector);
        factory.launch("X", "X", "", "", "b", 0, NeuronCurve.FeeMode.Creator);
    }

    function test_pause_sellsStillWork() public {
        NeuronCurve c = _launch("a");
        uint256 got = _buy(c, alice, 1 ether);
        vm.prank(guardian);
        factory.pauseBuys();
        uint256 before = alice.balance;
        _sell(c, alice, got);
        assertGt(alice.balance, before, "sell paid out while paused");
    }

    function test_pause_feeClaimsAndGraduationStillWork() public {
        NeuronCurve c = _launch("a");
        _buy(c, alice, 2 ether);
        vm.prank(guardian);
        factory.pauseBuys();
        c.claimProtocolFees();
        c.claimCreatorFees();
        vm.prank(operator);
        c.graduate(REPORT);
        assertEq(uint256(c.state()), uint256(NeuronCurve.State.Graduated));
    }

    function test_onlyOwnerUnpauses() public {
        vm.prank(guardian);
        factory.pauseBuys();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.unpauseBuys();
        vm.prank(owner);
        factory.unpauseBuys();
        assertFalse(factory.buysPaused());
    }

    function test_strangerCannotPause() public {
        vm.prank(alice);
        vm.expectRevert(NeuronCurveFactory.NotGuardian.selector);
        factory.pauseBuys();
    }

    function test_ownerCanPauseToo() public {
        vm.prank(owner);
        factory.pauseBuys();
        assertTrue(factory.buysPaused());
    }

    function test_guardianCannotChangeAnythingElse() public {
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setNativeCap(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setGuardian(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setProtocolFeeRecipient(guardian);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ cap

    function test_cap_blocksBuyOverCap_acrossCurves() public {
        vm.prank(owner);
        factory.setNativeCap(3 ether);
        NeuronCurve a = _launch("a");
        NeuronCurve b = _launch("b");
        _buy(a, alice, 1.5 ether);
        _buy(b, bob, 1.4 ether);
        assertLe(factory.totalNative(), 3 ether);

        vm.prank(alice);
        vm.expectRevert();
        b.buy{value: 1 ether}(0, alice);
    }

    function test_cap_sellFreesRoom() public {
        vm.prank(owner);
        factory.setNativeCap(2 ether);
        NeuronCurve a = _launch("a");
        uint256 got = _buy(a, alice, 2 ether);
        uint256 room = factory.capRoom();
        _sell(a, alice, got / 2);
        assertGt(factory.capRoom(), room, "sell frees room");
        _buy(a, bob, 0.5 ether);
    }

    function test_cap_launchWithFirstBuyRespectsCap() public {
        vm.prank(owner);
        factory.setNativeCap(1 ether);
        vm.prank(creator);
        vm.expectRevert();
        factory.launch{value: 2 ether}("X", "X", "", "", "a", 0, NeuronCurve.FeeMode.Creator);
    }

    function test_cap_zeroMeansNoCap() public {
        NeuronCurve a = _launch("a");
        _buy(a, alice, 50 ether); // sells the curve out, nothing blocked
        assertEq(a.tokensForSale(), 0);
        assertEq(factory.totalNative(), a.realNative());
    }

    function test_totalTracksRealNative_throughLifecycle() public {
        NeuronCurve a = _launch("a");
        NeuronCurve b = _launch("b");
        uint256 got = _buy(a, alice, 3 ether);
        _buy(b, bob, 1 ether);
        _sell(a, alice, got / 3);
        assertEq(factory.totalNative(), a.realNative() + b.realNative(), "total == sum of curves");

        vm.prank(operator);
        a.graduate(REPORT);
        assertEq(factory.totalNative(), b.realNative(), "graduation removes its money");
    }

    function test_buybackFees_neverBlockedByCap() public {
        vm.prank(creator);
        (address curve,,) = factory.launch("B", "B", "", "", "bb", 0, NeuronCurve.FeeMode.Buyback);
        NeuronCurve c = NeuronCurve(payable(curve));
        _buy(c, alice, 2 ether);
        uint256 full = factory.totalNative();
        vm.prank(owner);
        factory.setNativeCap(full);
        c.claimCreatorFees(); // buyback on the curve, must not revert
        assertEq(factory.totalNative(), c.realNative());
    }

    function test_onlyCurvesCanReport() public {
        vm.prank(alice);
        vm.expectRevert(NeuronCurveFactory.NotCurve.selector);
        factory.noteNativeIn(1 ether, false);
        vm.prank(alice);
        vm.expectRevert(NeuronCurveFactory.NotCurve.selector);
        factory.noteNativeOut(1 ether);
    }

    // ------------------------------------------------------------ Safe ownership

    function test_ownershipMovesToSafeInTwoSteps() public {
        vm.prank(owner);
        factory.transferOwnership(safe);
        assertEq(factory.owner(), owner, "not moved until accepted");
        vm.prank(safe);
        factory.acceptOwnership();
        assertEq(factory.owner(), safe);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        factory.unpauseBuys();
    }

    function test_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(NeuronCurveFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_totalEqualsSum(uint96 a1, uint96 b1, uint8 sellPct) public {
        uint256 x = bound(a1, 0.001 ether, 20 ether);
        uint256 y = bound(b1, 0.001 ether, 20 ether);
        NeuronCurve a = _launch("a");
        NeuronCurve b = _launch("b");
        uint256 got = _buy(a, alice, x);
        _buy(b, bob, y);
        uint256 s = (got * bound(sellPct, 0, 100)) / 100;
        if (s > 0) _sell(a, alice, s);
        assertEq(factory.totalNative(), a.realNative() + b.realNative());
    }
}
