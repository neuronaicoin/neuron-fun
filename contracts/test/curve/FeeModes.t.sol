// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {MockMigrator} from "./NeuronCurve.t.sol";

contract RefusesEth {
    receive() external payable {
        revert("no");
    }
}

/// @notice Fee modes: creator, buyback & burn, holders.
contract FeeModesTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
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
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _launch(NeuronCurve.FeeMode mode) internal returns (NeuronCurve c, CurveToken t) {
        vm.prank(creator);
        (address a,,) = factory.launch("Harbor Cat", "HCAT", "", "", keccak256(abi.encode(mode, block.number)), 0, mode);
        c = NeuronCurve(payable(a));
        t = c.token();
    }

    function _buy(NeuronCurve c, address who, uint256 amount) internal returns (uint256) {
        if (c.tokensForSale() == 0) return 0; // the test curve fills with ~2.8 ETH
        vm.prank(who);
        return c.buy{value: amount}(0, who);
    }

    function _sell(NeuronCurve c, CurveToken t, address who, uint256 amount) internal {
        vm.startPrank(who);
        t.approve(address(c), amount);
        c.sell(amount, 0, who);
        vm.stopPrank();
    }

    /// Balance the curve holds always covers what it owes.
    function _assertBooks(NeuronCurve c) internal view {
        assertEq(address(c).balance, c.realNative() + c.creatorFees() + c.protocolFees(), "curve books");
    }

    // ------------------------------------------------------------ setup

    function test_modeIsStoredAndEmitted() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Holders);
        assertEq(uint256(c.feeMode()), uint256(NeuronCurve.FeeMode.Holders));
    }

    function test_sharedBalancesAreExcluded() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        assertTrue(t.excluded(address(c)));
        assertTrue(t.excluded(DEAD));
        assertTrue(t.excluded(address(migrator)));
        assertTrue(t.excluded(migrator.poolManager()));
        assertFalse(t.excluded(alice));
        assertEq(t.rewardShares(), 0, "curve's supply earns nothing");
    }

    // ------------------------------------------------------------ creator mode

    function test_creatorMode_paysCreator() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Creator);
        _buy(c, alice, 1 ether);
        uint256 fees = c.creatorFees();
        uint256 before = creator.balance;
        vm.prank(bob); // anyone can trigger it
        assertEq(c.claimCreatorFees(), fees);
        assertEq(creator.balance - before, fees);
    }

    // ------------------------------------------------------------ holders mode

    function test_holdersMode_sharesByBalance() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 0.3 ether);
        _buy(c, bob, 0.1 ether);
        uint256 fees = c.creatorFees();
        c.claimCreatorFees();
        assertEq(c.creatorFees(), 0);

        uint256 a = t.claimable(alice);
        uint256 b = t.claimable(bob);
        assertApproxEqAbs(a + b, fees, 2, "everything shared");
        // In proportion to balances at distribution time.
        assertApproxEqRel(a * t.balanceOf(bob), b * t.balanceOf(alice), 1e12);
        assertEq(t.claimable(creator), 0);
        _assertBooks(c);
    }

    function test_holdersMode_claimPays() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 2 ether);
        c.claimCreatorFees();
        uint256 owed = t.claimable(alice);
        assertGt(owed, 0);
        uint256 before = carol.balance;
        vm.prank(alice);
        assertEq(t.claim(carol), owed);
        assertEq(carol.balance - before, owed);
        assertEq(t.claimable(alice), 0);
        vm.prank(alice);
        assertEq(t.claim(alice), 0, "nothing twice");
    }

    function test_holdersMode_rewardsStayWithWhoHeldThen() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 2 ether);
        c.claimCreatorFees();
        uint256 owed = t.claimable(alice);
        // Alice sends everything to bob after the payout: her reward stays hers.
        uint256 bal = t.balanceOf(alice);
        vm.prank(alice);
        t.transfer(bob, bal);
        assertEq(t.claimable(alice), owed);
        assertEq(t.claimable(bob), 0);
    }

    function test_holdersMode_sellersStopEarning() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 2 ether);
        _buy(c, bob, 2 ether);
        _sell(c, t, bob, t.balanceOf(bob)); // bob exits
        uint256 fees = c.creatorFees();
        c.claimCreatorFees();
        assertEq(t.claimable(bob), 0, "no balance, no share");
        assertApproxEqAbs(t.claimable(alice), fees, 2);
    }

    function test_holdersMode_waitsForEnoughHolders() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        // A dust buy: holders own less than MIN_SHARES.
        _buy(c, alice, 0.0001 ether);
        assertLt(t.rewardShares(), t.MIN_SHARES());
        uint256 fees = c.creatorFees();
        c.claimCreatorFees();
        assertEq(t.pendingRewards(), fees, "held back");
        assertEq(t.claimable(alice), 0);
        // Once real holders exist, the waiting money is shared with the next payout.
        _buy(c, bob, 1 ether);
        uint256 more = c.creatorFees();
        c.claimCreatorFees();
        assertEq(t.pendingRewards(), 0);
        assertApproxEqAbs(t.claimable(alice) + t.claimable(bob), fees + more, 2);
    }

    function test_holdersMode_refusingClaimantOnlyHurtsThemselves() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 2 ether);
        c.claimCreatorFees();
        RefusesEth sink = new RefusesEth();
        vm.prank(alice);
        vm.expectRevert(CurveToken.ClaimFailed.selector);
        t.claim(address(sink));
        // Nothing lost: she can still claim to herself.
        vm.prank(alice);
        assertGt(t.claim(alice), 0);
    }

    function test_holdersMode_worksAfterClose() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        _buy(c, alice, 2 ether);
        vm.prank(operator);
        c.close(REPORT);
        _sell(c, t, alice, t.balanceOf(alice) / 2);
        uint256 fees = c.creatorFees();
        c.claimCreatorFees();
        assertApproxEqAbs(t.claimable(alice), fees, 2);
    }

    // ------------------------------------------------------------ buyback mode

    function test_buyback_burnsAndRaisesPrice() public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Buyback);
        _buy(c, alice, 2 ether);
        uint256 fees = c.creatorFees();
        uint256 priceBefore = (c.virtualNative() * 1e18) / c.virtualToken();
        uint256 realBefore = c.realNative();
        uint256 deadBefore = t.balanceOf(DEAD);

        uint256 spent = c.claimCreatorFees();
        assertEq(spent, fees, "small fund spent in one go");
        assertGt(t.balanceOf(DEAD), deadBefore, "burned");
        assertGt((c.virtualNative() * 1e18) / c.virtualToken(), priceBefore, "price up");
        assertEq(c.realNative(), realBefore + spent, "money stays in the curve");
        assertEq(c.creatorFees(), 0);
        _assertBooks(c);
    }

    function test_buyback_chunked() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Buyback);
        // Lots of volume: the fund grows beyond one chunk.
        for (uint256 i; i < 20; i++) {
            _buy(c, alice, 5 ether);
            vm.startPrank(alice);
            c.token().approve(address(c), type(uint256).max);
            c.sell(c.token().balanceOf(alice), 0, alice);
            vm.stopPrank();
        }
        uint256 fund = c.creatorFees();
        uint256 cap = (c.virtualNative() * c.BUYBACK_CHUNK_BPS()) / 10_000;
        assertGt(fund, cap);
        uint256 spent = c.claimCreatorFees();
        assertEq(spent, cap, "one chunk per call");
        assertEq(c.creatorFees(), fund - cap);
        _assertBooks(c);
    }

    function test_buyback_neverSellsOut() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Buyback);
        _buy(c, alice, 1_000 ether); // buys (nearly) the whole sale
        uint256 left = c.tokensForSale();
        uint256 fees = c.creatorFees();
        uint256 spent = c.claimCreatorFees();
        if (spent == 0) {
            assertEq(c.creatorFees(), fees, "kept for later");
            assertEq(c.tokensForSale(), left);
        } else {
            assertGt(c.tokensForSale(), 0);
        }
        _assertBooks(c);
    }

    function test_buyback_afterGraduationGoesToMigrator() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Buyback);
        _buy(c, alice, 1 ether);
        vm.prank(operator);
        c.graduate(REPORT);
        uint256 fees = c.creatorFees();
        assertGt(fees, 0);
        c.claimCreatorFees();
        assertEq(migrator.buybackReceived(), fees);
        assertEq(c.creatorFees(), 0);
    }

    function test_buyback_losingChainPaysCreator() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Buyback);
        _buy(c, alice, 1 ether);
        vm.prank(operator);
        c.close(REPORT);
        uint256 fees = c.creatorFees();
        uint256 before = creator.balance;
        c.claimCreatorFees();
        assertEq(creator.balance - before, fees);
    }

    function test_buyback_tradeEventMarksBurn() public {
        (NeuronCurve c,) = _launch(NeuronCurve.FeeMode.Buyback);
        _buy(c, alice, 1 ether);
        vm.expectEmit(false, false, false, false, address(c));
        emit NeuronCurve.Buyback(0, 0);
        c.claimCreatorFees();
    }

    // ------------------------------------------------------------ fuzz

    /// Holder rewards never pay out more than was put in, whatever people do.
    function testFuzz_rewardsConserved(uint96[6] memory buys, uint8[6] memory who, uint8[6] memory action) public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Holders);
        address[3] memory people = [alice, bob, carol];
        uint256 paidIn;
        for (uint256 i; i < 6; i++) {
            address p = people[who[i] % 3];
            uint256 amount = bound(uint256(buys[i]), 0.001 ether, 1 ether);
            uint8 a = action[i] % 4;
            if (a == 0 || t.balanceOf(p) == 0) {
                _buy(c, p, amount);
            } else if (a == 1) {
                _sell(c, t, p, t.balanceOf(p) / 2);
            } else if (a == 2) {
                address q = people[(uint256(who[i]) + 1) % 3];
                uint256 bal = t.balanceOf(p) / 3;
                vm.prank(p);
                t.transfer(q, bal);
            } else {
                vm.prank(p);
                t.claim(p);
            }
            uint256 fees = c.creatorFees();
            c.claimCreatorFees();
            paidIn += fees;
        }
        uint256 owed = t.claimable(alice) + t.claimable(bob) + t.claimable(carol);
        // The token holds everything still owed (plus any waiting money and rounding dust).
        assertGe(address(t).balance, owed + t.pendingRewards());
        assertLe(t.totalDistributed() + t.pendingRewards(), paidIn);
        _assertBooks(c);
    }

    /// Buybacks keep the curve's books balanced and its reserve able to pay sellers.
    function testFuzz_buybackKeepsBooks(uint96[5] memory buys, bool[5] memory sells) public {
        (NeuronCurve c, CurveToken t) = _launch(NeuronCurve.FeeMode.Buyback);
        for (uint256 i; i < 5; i++) {
            _buy(c, alice, bound(uint256(buys[i]), 0.001 ether, 1 ether));
            if (sells[i]) _sell(c, t, alice, t.balanceOf(alice) / 2);
            c.claimCreatorFees();
            _assertBooks(c);
        }
        // Alice can still sell everything back.
        uint256 bal = t.balanceOf(alice);
        if (bal > 0) _sell(c, t, alice, bal);
        _assertBooks(c);
    }
}
