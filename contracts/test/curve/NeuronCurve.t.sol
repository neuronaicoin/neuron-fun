// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {NeuronCurve, IGraduationMigrator} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";

contract MockMigrator is IGraduationMigrator {
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastNative;
    uint256 public calls;

    function migrate(address token, uint256 tokenAmount) external payable {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastNative = msg.value;
        calls++;
        require(CurveToken(token).balanceOf(address(this)) >= tokenAmount, "tokens not delivered");
    }
}

/// Tries to re-enter the curve when it receives native coin.
contract Reenterer {
    NeuronCurve public curve;
    bool public armed;

    function set(NeuronCurve c) external {
        curve = c;
    }

    function buy() external payable {
        curve.buy{value: msg.value}(0, address(this));
    }

    function sellAll() external {
        uint256 bal = curve.token().balanceOf(address(this));
        curve.token().approve(address(curve), bal);
        armed = true;
        curve.sell(bal / 2, 0, address(this));
    }

    receive() external payable {
        if (armed) {
            armed = false;
            curve.sell(1e18, 0, address(this)); // must fail
        }
    }
}

contract NeuronCurveTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 constant V0 = 1 ether;
    uint256 constant T0 = 1_073_000_000 ether;
    uint256 constant SALE = 793_100_000 ether;
    uint256 constant GRAD = 206_900_000 ether;
    uint256 constant MIN_GRAD = 0.5 ether;
    bytes32 constant REPORT = keccak256("tally");

    MockMigrator migrator;
    NeuronCurveFactory factory;

    function setUp() public {
        migrator = new MockMigrator();
        factory = new NeuronCurveFactory(owner, migrator, operator, protocol, _config());
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _config() internal pure returns (NeuronCurveFactory.Config memory) {
        return NeuronCurveFactory.Config({
            virtualNative: V0,
            virtualToken: T0,
            tokensForSale: SALE,
            graduationTokens: GRAD,
            feeBps: 100,
            creatorShareBps: 3_000,
            minGraduationNative: MIN_GRAD
        });
    }

    function _launch() internal returns (NeuronCurve c, CurveToken t) {
        vm.prank(creator);
        (address curve,,) = factory.launch("Harbor Cat", "HCAT", "", "", keccak256("k1"), 0);
        c = NeuronCurve(payable(curve));
        t = c.token();
    }

    function _buy(NeuronCurve c, address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = c.buy{value: amount}(0, who);
    }

    function _sell(NeuronCurve c, address who, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(who);
        c.token().approve(address(c), amount);
        out = c.sell(amount, 0, who);
        vm.stopPrank();
    }

    /// Native held == native owed to sellers + unclaimed fees.
    function _assertBooks(NeuronCurve c) internal view {
        assertEq(address(c).balance, c.realNative() + c.creatorFees() + c.protocolFees(), "books");
    }

    /// Selling every outstanding token back would never need more than the curve holds.
    function _assertSolvent(NeuronCurve c) internal view {
        uint256 outstanding = SALE - c.tokensForSale();
        uint256 v = c.virtualNative();
        uint256 t = c.virtualToken();
        uint256 k = v * t;
        uint256 need = v - ((k - 1) / (t + outstanding) + 1);
        if (outstanding == 0) need = 0;
        assertLe(need, c.realNative(), "insolvent");
    }

    // ------------------------------------------------------------ launch

    function test_launch_mintsFixedSupplyToCurve() public {
        (NeuronCurve c, CurveToken t) = _launch();
        assertEq(t.totalSupply(), SALE + GRAD);
        assertEq(t.balanceOf(address(c)), SALE + GRAD);
        assertEq(c.creator(), creator);
        assertEq(c.launchKey(), keccak256("k1"));
        assertEq(uint8(c.state()), uint8(NeuronCurve.State.Trading));
        assertTrue(factory.isCurve(address(c)));
        assertEq(factory.curveCount(), 1);
    }

    function test_launch_closedByDefault() public {
        NeuronCurveFactory f = new NeuronCurveFactory(owner, migrator, operator, protocol, _config());
        vm.prank(creator);
        vm.expectRevert(NeuronCurveFactory.LaunchesClosed.selector);
        f.launch("A", "A", "", "", bytes32(0), 0);
    }

    function test_launch_needsNameAndSymbol() public {
        vm.prank(creator);
        vm.expectRevert(NeuronCurveFactory.BadConfig.selector);
        factory.launch("", "A", "", "", bytes32(0), 0);
    }

    function test_launch_firstBuyGoesToCreator() public {
        uint256 before = creator.balance;
        vm.prank(creator);
        (address curve,, uint256 bought) = factory.launch{value: 0.5 ether}("A", "A", "", "", bytes32(0), 0);
        NeuronCurve c = NeuronCurve(payable(curve));
        assertGt(bought, 0);
        assertEq(c.token().balanceOf(creator), bought);
        assertEq(before - creator.balance, 0.5 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_launch_firstBuySelloutRefundsCreator() public {
        uint256 before = creator.balance;
        vm.prank(creator);
        (address curve,, uint256 bought) = factory.launch{value: 500 ether}("A", "A", "", "", bytes32(0), 0);
        NeuronCurve c = NeuronCurve(payable(curve));
        assertEq(bought, SALE);
        uint256 spent = before - creator.balance;
        assertLt(spent, 500 ether);
        assertEq(spent, c.realNative() + c.creatorFees() + c.protocolFees());
        assertEq(address(factory).balance, 0);
    }

    function test_factory_onlyOwnerAdmin() public {
        vm.startPrank(alice);
        vm.expectRevert();
        factory.setConfig(_config());
        vm.expectRevert();
        factory.setOperator(alice);
        vm.expectRevert();
        factory.setProtocolFeeRecipient(alice);
        vm.expectRevert();
        factory.setLaunchesOpen(false);
        vm.stopPrank();
    }

    function test_factory_rejectsBadConfig() public {
        NeuronCurveFactory.Config memory c = _config();
        c.feeBps = 1_001;
        vm.prank(owner);
        vm.expectRevert(NeuronCurveFactory.BadConfig.selector);
        factory.setConfig(c);
        c = _config();
        c.virtualToken = SALE;
        vm.prank(owner);
        vm.expectRevert(NeuronCurveFactory.BadConfig.selector);
        factory.setConfig(c);
    }

    function test_factory_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(factory).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_factory_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(NeuronCurveFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    // ------------------------------------------------------------ buy / sell

    function test_buy_matchesQuoteAndBooks() public {
        (NeuronCurve c, CurveToken t) = _launch();
        uint256 quoted = c.quoteBuy(1 ether);
        uint256 out = _buy(c, alice, 1 ether);
        assertEq(out, quoted);
        assertEq(t.balanceOf(alice), out);
        // 1% on top of the net: fee is about 0.99% of what was paid.
        uint256 fee = c.creatorFees() + c.protocolFees();
        assertApproxEqRel(fee, uint256(1 ether) / 101, 0.001e18);
        assertEq(c.creatorFees(), fee * 3_000 / 10_000);
        _assertBooks(c);
        _assertSolvent(c);
    }

    function test_buy_slippage() public {
        (NeuronCurve c,) = _launch();
        uint256 quoted = c.quoteBuy(1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuronCurve.Slippage.selector, quoted, quoted + 1));
        c.buy{value: 1 ether}(quoted + 1, alice);
    }

    function test_buy_zeroReverts() public {
        (NeuronCurve c,) = _launch();
        vm.prank(alice);
        vm.expectRevert(NeuronCurve.ZeroAmount.selector);
        c.buy{value: 0}(0, alice);
    }

    function test_buy_selloutCapsAndRefunds() public {
        (NeuronCurve c, CurveToken t) = _launch();
        uint256 before = alice.balance;
        uint256 out = _buy(c, alice, 900 ether);
        assertEq(out, SALE);
        assertEq(c.tokensForSale(), 0);
        assertEq(t.balanceOf(alice), SALE);
        assertEq(before - alice.balance, c.realNative() + c.creatorFees() + c.protocolFees());
        _assertBooks(c);
        vm.prank(bob);
        vm.expectRevert(NeuronCurve.SoldOut.selector);
        c.buy{value: 1 ether}(0, bob);
    }

    function test_sell_matchesQuoteAndBooks() public {
        (NeuronCurve c,) = _launch();
        uint256 got = _buy(c, alice, 2 ether);
        uint256 quoted = c.quoteSell(got / 2);
        uint256 before = alice.balance;
        uint256 out = _sell(c, alice, got / 2);
        assertEq(out, quoted);
        assertEq(alice.balance - before, out);
        _assertBooks(c);
        _assertSolvent(c);
    }

    function test_sell_needsApproval() public {
        (NeuronCurve c,) = _launch();
        uint256 got = _buy(c, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        c.sell(got, 0, alice);
    }

    function test_sell_slippage() public {
        (NeuronCurve c, CurveToken t) = _launch();
        uint256 got = _buy(c, alice, 1 ether);
        uint256 quoted = c.quoteSell(got);
        vm.startPrank(alice);
        t.approve(address(c), got);
        vm.expectRevert(abi.encodeWithSelector(NeuronCurve.Slippage.selector, quoted, quoted + 1));
        c.sell(got, quoted + 1, alice);
        vm.stopPrank();
    }

    function test_everyoneCanExit() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 0.6 ether);
        _buy(c, bob, 1 ether);
        _buy(c, alice, 0.2 ether);
        _sell(c, bob, t.balanceOf(bob));
        _sell(c, alice, t.balanceOf(alice));
        assertEq(c.tokensForSale(), SALE);
        _assertBooks(c);
        // Only rounding dust can remain, and it stays in the curve.
        assertLt(c.realNative(), 10);
    }

    function test_roundTripLosesOnlyFees() public {
        (NeuronCurve c, CurveToken t) = _launch();
        uint256 before = alice.balance;
        _buy(c, alice, 1 ether);
        _sell(c, alice, t.balanceOf(alice));
        uint256 lost = before - alice.balance;
        // About 1% in and 1% out.
        assertApproxEqRel(lost, uint256(0.0197 ether), 0.01e18);
    }

    function test_reentrancyBlocked() public {
        (NeuronCurve c,) = _launch();
        Reenterer r = new Reenterer();
        r.set(c);
        vm.deal(address(r), 0);
        r.buy{value: 1 ether}();
        vm.expectRevert(NeuronCurve.TransferFailed.selector);
        r.sellAll();
    }

    // ------------------------------------------------------------ close / graduate

    function test_close_onlyOperator_stopsBuysKeepsSells() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 2 ether);
        vm.prank(alice);
        vm.expectRevert(NeuronCurve.NotOperator.selector);
        c.close(REPORT);

        vm.prank(operator);
        c.close(REPORT);
        vm.prank(bob);
        vm.expectRevert(NeuronCurve.NotTrading.selector);
        c.buy{value: 1 ether}(0, bob);

        _sell(c, alice, t.balanceOf(alice));
        assertEq(t.balanceOf(alice), 0);
        _assertBooks(c);

        vm.prank(operator);
        vm.expectRevert(NeuronCurve.NotTrading.selector);
        c.graduate(REPORT);
    }

    function test_graduate_movesFundsAtCurvePrice() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 1 ether);
        _buy(c, bob, 0.4 ether);
        uint256 realN = c.realNative();
        uint256 v = c.virtualNative();
        uint256 vt = c.virtualToken();
        uint256 supplyBefore = t.totalSupply();

        vm.prank(alice);
        vm.expectRevert(NeuronCurve.NotOperator.selector);
        c.graduate(REPORT);

        vm.prank(operator);
        c.graduate(REPORT);

        assertEq(migrator.calls(), 1);
        assertEq(migrator.lastNative(), realN);
        assertEq(migrator.lastToken(), address(t));
        uint256 expectTokens = (realN * vt) / v;
        assertEq(migrator.lastTokenAmount(), expectTokens);
        assertEq(t.balanceOf(address(migrator)), expectTokens);
        // Nothing left in the curve but unclaimed fees.
        assertEq(t.balanceOf(address(c)), 0);
        assertEq(address(c).balance, c.creatorFees() + c.protocolFees());
        // Supply is unchanged; the rest sits at the dead address.
        assertEq(t.totalSupply(), supplyBefore);
        assertEq(t.balanceOf(DEAD) + t.balanceOf(address(migrator)) + t.balanceOf(alice) + t.balanceOf(bob), supplyBefore);

        // No more curve trading.
        vm.prank(bob);
        vm.expectRevert(NeuronCurve.NotTrading.selector);
        c.buy{value: 1 ether}(0, bob);
        vm.startPrank(alice);
        t.approve(address(c), 1);
        vm.expectRevert(NeuronCurve.AlreadyGraduated.selector);
        c.sell(1, 0, alice);
        vm.stopPrank();
    }

    function test_graduate_afterSellout_fitsReservedTokens() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 900 ether);
        vm.prank(operator);
        c.graduate(REPORT);
        // At sell-out the reserved tokens cover the pool at the final price.
        uint256 poolTokens = migrator.lastTokenAmount();
        assertLe(poolTokens, GRAD);
        assertEq(t.balanceOf(DEAD), GRAD - poolTokens);
    }

    function test_graduate_refusedBelowMinimum() public {
        (NeuronCurve c,) = _launch();
        _buy(c, alice, 0.1 ether);
        uint256 have = c.realNative();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NeuronCurve.BelowGraduationMinimum.selector, have, MIN_GRAD));
        c.graduate(REPORT);
    }

    function test_decisionsNeedAReport() public {
        (NeuronCurve c,) = _launch();
        _buy(c, alice, 1 ether);
        vm.startPrank(operator);
        vm.expectRevert(NeuronCurve.NoReport.selector);
        c.close(bytes32(0));
        vm.expectRevert(NeuronCurve.NoReport.selector);
        c.graduate(bytes32(0));
        vm.stopPrank();
    }

    function test_operatorCannotTouchMoney() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 1 ether);
        uint256 opBefore = operator.balance;
        uint256 opTokens = t.balanceOf(operator);
        vm.startPrank(operator);
        c.graduate(REPORT);
        c.claimCreatorFees();
        c.claimProtocolFees();
        vm.stopPrank();
        assertEq(operator.balance, opBefore);
        assertEq(t.balanceOf(operator), opTokens);
    }

    function test_operatorRotation() public {
        (NeuronCurve c,) = _launch();
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        factory.setOperator(newOp);
        vm.prank(operator);
        vm.expectRevert(NeuronCurve.NotOperator.selector);
        c.close(REPORT);
        vm.prank(newOp);
        c.close(REPORT);
    }

    // ------------------------------------------------------------ fees

    function test_fees_claimToFixedRecipients() public {
        (NeuronCurve c, CurveToken t) = _launch();
        _buy(c, alice, 5 ether);
        _sell(c, alice, t.balanceOf(alice) / 3);
        uint256 cf = c.creatorFees();
        uint256 pf = c.protocolFees();
        assertGt(cf, 0);
        assertGt(pf, 0);

        uint256 cb = creator.balance;
        uint256 pb = protocol.balance;
        vm.prank(bob); // anyone can trigger; money only goes to the fixed recipients
        c.claimCreatorFees();
        c.claimProtocolFees();
        assertEq(creator.balance - cb, cf);
        assertEq(protocol.balance - pb, pf);
        assertEq(c.creatorFees(), 0);
        assertEq(c.protocolFees(), 0);
        _assertBooks(c);
    }

    function test_fees_claimableAfterGraduation() public {
        (NeuronCurve c,) = _launch();
        _buy(c, alice, 5 ether);
        uint256 cf = c.creatorFees();
        vm.prank(operator);
        c.graduate(REPORT);
        uint256 cb = creator.balance;
        c.claimCreatorFees();
        assertEq(creator.balance - cb, cf);
    }

    function test_newRecipientOnlyForNewCurves() public {
        (NeuronCurve c,) = _launch();
        vm.prank(owner);
        factory.setProtocolFeeRecipient(bob);
        assertEq(c.protocolFeeRecipient(), protocol);
    }

    // ------------------------------------------------------------ fuzz

    /// Random buys and sells by two traders: the books always balance, the
    /// curve always holds enough to buy everything back, k never drops, and
    /// at the end both traders can sell everything.
    function testFuzz_solvency(uint256 seed) public {
        (NeuronCurve c, CurveToken t) = _launch();
        address[2] memory who = [alice, bob];
        uint256 lastK = c.virtualNative() * c.virtualToken();
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address u = who[seed % 2];
            bool isBuy = (seed >> 8) % 3 != 0;
            if (isBuy && c.tokensForSale() > 0) {
                uint256 amt = bound(seed >> 16, 1e9, 1.5 ether);
                _buy(c, u, amt);
            } else {
                uint256 bal = t.balanceOf(u);
                if (bal == 0) continue;
                uint256 amt = bound(seed >> 16, 1, bal);
                if (c.quoteSell(amt) == 0) continue;
                _sell(c, u, amt);
            }
            uint256 k = c.virtualNative() * c.virtualToken();
            assertGe(k, lastK, "k dropped");
            lastK = k;
            _assertBooks(c);
            _assertSolvent(c);
        }
        for (uint256 j; j < 2; ++j) {
            uint256 bal = t.balanceOf(who[j]);
            if (bal > 0 && c.quoteSell(bal) > 0) _sell(c, who[j], bal);
        }
        _assertBooks(c);
    }

    function testFuzz_buyNeverOvercharges(uint256 amount) public {
        (NeuronCurve c,) = _launch();
        amount = bound(amount, 1e6, 999 ether);
        uint256 before = alice.balance;
        uint256 out = _buy(c, alice, amount);
        uint256 spent = before - alice.balance;
        assertLe(spent, amount);
        assertGt(out, 0);
        assertEq(spent, c.realNative() + c.creatorFees() + c.protocolFees());
    }
}
