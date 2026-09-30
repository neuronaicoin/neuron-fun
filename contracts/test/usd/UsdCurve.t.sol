// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSDC} from "../../src/usd/TestUSDC.sol";
import {UsdCurve, IUsdMigrator} from "../../src/usd/UsdCurve.sol";
import {UsdCurveFactory} from "../../src/usd/UsdCurveFactory.sol";
import {UsdToken} from "../../src/usd/UsdToken.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {MockMigrator} from "../curve/NeuronCurve.t.sol";

contract MockUsdMigrator is IUsdMigrator {
    IERC20 public usdc;
    address public lastToken;
    uint256 public lastTokens;
    uint256 public lastUsdc;
    uint256 public buyback;

    constructor(IERC20 u) {
        usdc = u;
    }

    function poolManager() external pure returns (address) {
        return address(0xB0B);
    }

    function migrate(address token, uint256 tokenAmount, uint256 usdcAmount) external {
        require(IERC20(token).balanceOf(address(this)) >= tokenAmount, "tokens not delivered");
        require(usdc.balanceOf(address(this)) >= usdcAmount, "usdc not delivered");
        lastToken = token;
        lastTokens = tokenAmount;
        lastUsdc = usdcAmount;
    }

    function depositBuyback(address, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        buyback += amount;
    }
}

contract UsdCurveTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 constant REPORT = keccak256("tally");

    TestUSDC usdc;
    MockUsdMigrator mig;
    UsdCurveFactory factory;

    // $1,000 virtual, same token numbers as v4; graduates at >= $3,000 real
    UsdCurveFactory.Config cfg = UsdCurveFactory.Config({
        virtualNative: 1_000e6,
        virtualToken: 1_073_000_000 ether,
        tokensForSale: 793_100_000 ether,
        graduationTokens: 206_900_000 ether,
        feeBps: 100,
        creatorShareBps: 3_000,
        minGraduationNative: 1_000e6
    });

    function setUp() public {
        usdc = new TestUSDC();
        mig = new MockUsdMigrator(IERC20(address(usdc)));
        factory = new UsdCurveFactory(owner, mig, operator, protocol, cfg, IERC20(address(usdc)));
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        _fund(creator, 100_000e6);
        _fund(alice, 100_000e6);
        _fund(bob, 100_000e6);
    }

    function _fund(address who, uint256 amt) internal {
        deal(address(usdc), who, amt);
        vm.prank(who);
        usdc.approve(address(factory), type(uint256).max);
    }

    function _launch(uint256 firstBuy, UsdCurve.FeeMode mode) internal returns (UsdCurve c, UsdToken t) {
        vm.prank(creator);
        (address curve,,) = factory.launch("Cat", "CAT", "", "", "k", firstBuy, 0, mode);
        c = UsdCurve(curve);
        t = c.token();
    }

    function _buy(UsdCurve c, address who, uint256 amt) internal returns (uint256 out) {
        vm.startPrank(who);
        usdc.approve(address(c), amt);
        out = c.buy(amt, 0, who);
        vm.stopPrank();
    }

    function _sell(UsdCurve c, address who, uint256 amt) internal returns (uint256 out) {
        vm.startPrank(who);
        c.token().approve(address(c), amt);
        out = c.sell(amt, 0, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ basics

    function test_buyPullsExactCost_noLeftoverAllowanceNeeded() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        uint256 before = usdc.balanceOf(alice);
        uint256 out = _buy(c, alice, 100e6);
        assertEq(t.balanceOf(alice), out);
        // Rounding is always in the curve's favour and at most 1 unit ($0.000001).
        assertApproxEqAbs(before - usdc.balanceOf(alice), 100e6, 1, "a normal buy spends what was asked, fee included");
        assertEq(usdc.balanceOf(address(c)), c.realNative() + c.creatorFees() + c.protocolFees(), "every cent accounted for");
        assertEq(t.decimals(), 18);
    }

    function test_sellPaysUsdc_andFeesSplit() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        uint256 got = _buy(c, alice, 500e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 paid = _sell(c, alice, got);
        assertEq(usdc.balanceOf(alice) - before, paid);
        assertEq(t.balanceOf(alice), 0);
        // round trip loses about 2% in fees, nothing more
        assertApproxEqRel(paid, (500e6 * 98) / 100, 0.002e18);
        assertLe(c.realNative(), 1, "all dollars back out (at most $0.000001 of rounding stays, as in v4)");
        uint256 fees = c.creatorFees() + c.protocolFees();
        assertEq(usdc.balanceOf(address(c)), fees + c.realNative());
        assertApproxEqAbs((c.creatorFees() * 10_000) / fees, 3_000, 1, "creator gets 30%");
    }

    function test_soldOut_pullsOnlyWhatItCosts() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        uint256 before = usdc.balanceOf(alice);
        vm.startPrank(alice);
        usdc.approve(address(c), 50_000e6);
        uint256 out = c.buy(50_000e6, 0, alice);
        vm.stopPrank();
        assertEq(out, 793_100_000 ether, "bought everything for sale");
        assertEq(c.tokensForSale(), 0);
        uint256 spent = before - usdc.balanceOf(alice);
        assertLt(spent, 50_000e6, "didn't take the whole approval");
        assertEq(usdc.balanceOf(address(c)), c.realNative() + c.creatorFees() + c.protocolFees());
        assertEq(t.balanceOf(alice), out);
    }

    function test_slippageAndZero() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        vm.startPrank(alice);
        usdc.approve(address(c), 10e6);
        vm.expectRevert(UsdCurve.ZeroAmount.selector);
        c.buy(0, 0, alice);
        uint256 q = c.quoteBuy(10e6);
        vm.expectRevert(abi.encodeWithSelector(UsdCurve.Slippage.selector, q, q + 1));
        c.buy(10e6, q + 1, alice);
        vm.stopPrank();
    }

    function test_noApproval_reverts() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        vm.prank(alice);
        vm.expectRevert();
        c.buy(10e6, 0, alice);
    }

    // ------------------------------------------------------------ launch

    function test_launchWithFirstBuy() public {
        uint256 before = usdc.balanceOf(creator);
        (UsdCurve c, UsdToken t) = _launch(25e6, UsdCurve.FeeMode.Creator);
        assertGt(t.balanceOf(creator), 0, "creator got the first coins");
        assertEq(before - usdc.balanceOf(creator), 25e6);
        assertEq(usdc.balanceOf(address(factory)), 0, "factory keeps nothing");
        assertEq(usdc.allowance(address(factory), address(c)), 0, "no leftover allowance");
    }

    function test_launchFirstBuySoldOut_refundsCreator() public {
        uint256 before = usdc.balanceOf(creator);
        (UsdCurve c,) = _launch(50_000e6, UsdCurve.FeeMode.Creator);
        assertEq(c.tokensForSale(), 0);
        uint256 spent = before - usdc.balanceOf(creator);
        assertEq(spent, usdc.balanceOf(address(c)), "creator paid exactly what the curve holds");
        assertEq(usdc.balanceOf(address(factory)), 0);
    }

    function test_strayUsdcInFactory_notGivenToLauncher() public {
        deal(address(usdc), address(factory), 7e6);
        uint256 before = usdc.balanceOf(creator);
        _launch(50_000e6, UsdCurve.FeeMode.Creator);
        uint256 spent = before - usdc.balanceOf(creator);
        assertGt(spent, 0);
        assertEq(usdc.balanceOf(address(factory)), 7e6, "someone else's money stays put");
    }

    // ------------------------------------------------------------ fee modes

    function test_holdersMode_paysRewardsInUsdc() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Holders);
        _buy(c, alice, 2_000e6);
        _buy(c, bob, 1_000e6);
        uint256 fees = c.creatorFees();
        assertGt(fees, 0);
        c.claimCreatorFees();
        assertEq(c.creatorFees(), 0);
        uint256 a = t.claimable(alice);
        uint256 b = t.claimable(bob);
        assertApproxEqAbs(a + b, fees, 2, "shared among holders");
        assertGt(a, b, "bigger holder, bigger share");
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        t.claim(alice);
        assertEq(usdc.balanceOf(alice) - before, a);
    }

    function test_creatorMode_paysCreator() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        _buy(c, alice, 1_000e6);
        uint256 fees = c.creatorFees();
        uint256 before = usdc.balanceOf(creator);
        c.claimCreatorFees();
        assertEq(usdc.balanceOf(creator) - before, fees);
    }

    function test_buybackMode_burnsOnCurve_thenForwardsAfterGraduation() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Buyback);
        _buy(c, alice, 2_000e6);
        uint256 deadBefore = t.balanceOf(c.DEAD());
        c.claimCreatorFees();
        assertGt(t.balanceOf(c.DEAD()), deadBefore, "bought back and burned");
        assertEq(usdc.balanceOf(address(c)), c.realNative() + c.creatorFees() + c.protocolFees());
        // after graduation the fund goes to the migrator
        vm.prank(operator);
        c.graduate(REPORT);
        _buyAfter(c);
    }

    function _buyAfter(UsdCurve c) internal {
        uint256 left = c.creatorFees();
        if (left == 0) return;
        c.claimCreatorFees();
        assertEq(mig.buyback(), left);
    }

    function test_protocolFees() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        _buy(c, alice, 1_000e6);
        uint256 f = c.protocolFees();
        c.claimProtocolFees();
        assertEq(usdc.balanceOf(protocol), f);
    }

    // ------------------------------------------------------------ graduation / close

    function test_graduate_handsUsdcAndTokensToMigrator() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        _buy(c, alice, 3_000e6);
        uint256 real = c.realNative();
        vm.prank(operator);
        c.graduate(REPORT);
        assertEq(mig.lastUsdc(), real);
        assertEq(usdc.balanceOf(address(mig)), real);
        assertEq(t.balanceOf(address(mig)), mig.lastTokens());
        assertEq(uint256(c.state()), uint256(UsdCurve.State.Graduated));
        assertEq(usdc.balanceOf(address(c)), c.creatorFees() + c.protocolFees(), "only fees stay");
    }

    function test_graduate_belowMinimum_reverts() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        _buy(c, alice, 100e6);
        vm.prank(operator);
        vm.expectRevert();
        c.graduate(REPORT);
    }

    function test_closed_sellsStayOpen() public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        uint256 got = _buy(c, alice, 500e6);
        vm.prank(operator);
        c.close(REPORT);
        vm.startPrank(alice);
        usdc.approve(address(c), 10e6);
        vm.expectRevert(UsdCurve.NotTrading.selector);
        c.buy(10e6, 0, alice);
        vm.stopPrank();
        _sell(c, alice, got);
        assertEq(t.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------ beta locks & creator lock

    function test_pause_blocksBuys_notSells() public {
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        uint256 got = _buy(c, alice, 100e6);
        vm.prank(owner);
        factory.pauseBuys();
        vm.startPrank(alice);
        usdc.approve(address(c), 10e6);
        vm.expectRevert(UsdCurve.BuysPaused.selector);
        c.buy(10e6, 0, alice);
        vm.stopPrank();
        _sell(c, alice, got);
    }

    function test_cap_inDollars() public {
        vm.prank(owner);
        factory.setNativeCap(500e6);
        (UsdCurve c,) = _launch(0, UsdCurve.FeeMode.Creator);
        _buy(c, alice, 400e6);
        vm.startPrank(bob);
        usdc.approve(address(c), 200e6);
        vm.expectRevert();
        c.buy(200e6, 0, bob);
        vm.stopPrank();
    }

    function test_creatorLock_works() public {
        vm.prank(creator);
        (address curve,,) = factory.launchLocked("Cat", "CAT", "", "", "k", 25e6, 0, UsdCurve.FeeMode.Creator, 1 hours);
        UsdCurve c = UsdCurve(curve);
        UsdToken t = c.token();
        uint256 bal = t.balanceOf(creator);
        vm.startPrank(creator);
        t.approve(address(c), bal);
        vm.expectRevert(abi.encodeWithSelector(UsdToken.CreatorLocked.selector, block.timestamp + 1 hours));
        c.sell(bal, 0, creator);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours);
        _sell(c, creator, bal);
    }

    // ------------------------------------------------------------ same math as the audited v4 curve

    /// With identical numbers, v5 (USDC) must price every trade exactly like v4 (native).
    function testFuzz_parityWithV4(uint64 a, uint64 b, uint64 sellPart) public {
        NeuronCurveFactory v4 = new NeuronCurveFactory(
            owner,
            new MockMigrator(),
            operator,
            protocol,
            NeuronCurveFactory.Config({
                virtualNative: cfg.virtualNative,
                virtualToken: cfg.virtualToken,
                tokensForSale: cfg.tokensForSale,
                graduationTokens: cfg.graduationTokens,
                feeBps: cfg.feeBps,
                creatorShareBps: cfg.creatorShareBps,
                minGraduationNative: cfg.minGraduationNative
            })
        );
        vm.prank(owner);
        v4.setLaunchesOpen(true);
        vm.prank(creator);
        (address c4addr,,) = v4.launch("Cat", "CAT", "", "", "k", 0, NeuronCurve.FeeMode.Creator);
        NeuronCurve c4 = NeuronCurve(payable(c4addr));
        (UsdCurve c5, UsdToken t5) = _launch(0, UsdCurve.FeeMode.Creator);

        uint256 x = bound(a, 1e4, 5_000e6); // from $0.01
        uint256 y = bound(b, 1e4, 5_000e6);
        vm.deal(alice, 1e30);

        vm.prank(alice);
        uint256 o4 = c4.buy{value: x}(0, alice);
        uint256 o5 = _buy(c5, alice, x);
        assertEq(o5, o4, "first buy");

        if (c4.tokensForSale() > 0) {
            vm.prank(alice);
            uint256 p4 = c4.buy{value: y}(0, alice);
            uint256 p5 = _buy(c5, alice, y);
            assertEq(p5, p4, "second buy");
        }

        uint256 amt = (t5.balanceOf(alice) * bound(sellPart, 1, 100)) / 100;
        if (amt == 0) return;
        vm.startPrank(alice);
        CurveToken(address(c4.token())).approve(address(c4), amt);
        uint256 s4 = c4.sell(amt, 0, alice);
        vm.stopPrank();
        uint256 s5 = _sell(c5, alice, amt);
        assertEq(s5, s4, "sell");
        assertEq(c5.virtualNative(), c4.virtualNative());
        assertEq(c5.realNative(), c4.realNative());
        assertEq(c5.creatorFees(), c4.creatorFees());
        assertEq(c5.protocolFees(), c4.protocolFees());
    }

    /// The curve always holds every dollar it owes.
    function testFuzz_solvency(uint64[6] memory amts, uint8 seed) public {
        (UsdCurve c, UsdToken t) = _launch(0, UsdCurve.FeeMode.Creator);
        address[2] memory who = [alice, bob];
        for (uint256 i; i < amts.length; ++i) {
            address w = who[(seed + i) % 2];
            if ((seed >> (i % 8)) & 1 == 0 && c.tokensForSale() > 0) {
                uint256 x = bound(amts[i], 1e6, 3_000e6);
                vm.startPrank(w);
                usdc.approve(address(c), x);
                try c.buy(x, 0, w) {} catch {}
                vm.stopPrank();
            } else {
                uint256 bal = t.balanceOf(w);
                if (bal == 0) continue;
                uint256 s = (bal * bound(amts[i], 1, 100)) / 100;
                if (s == 0) continue;
                vm.startPrank(w);
                t.approve(address(c), s);
                try c.sell(s, 0, w) {} catch {}
                vm.stopPrank();
            }
            assertEq(usdc.balanceOf(address(c)), c.realNative() + c.creatorFees() + c.protocolFees(), "books balance");
        }
        // everyone can always exit
        uint256 ba = t.balanceOf(alice);
        if (ba > 0) _sell(c, alice, ba);
        uint256 bb = t.balanceOf(bob);
        if (bb > 0) _sell(c, bob, bb);
        // Only rounding dust (a few millionths of a dollar) can stay behind.
        assertLe(c.realNative(), 10);
    }

    function test_testUsdcFaucet() public {
        address u = makeAddr("newuser");
        usdc.faucet(u);
        assertEq(usdc.balanceOf(u), 100e6);
        vm.expectRevert();
        usdc.faucet(u);
        vm.warp(block.timestamp + 1 days);
        usdc.faucet(u);
        assertEq(usdc.balanceOf(u), 200e6);
    }
}
