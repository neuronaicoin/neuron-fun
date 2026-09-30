// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestUSDC} from "../../src/usd/TestUSDC.sol";
import {UsdCurve} from "../../src/usd/UsdCurve.sol";
import {UsdToken} from "../../src/usd/UsdToken.sol";
import {UsdCurveFactory} from "../../src/usd/UsdCurveFactory.sol";
import {UsdOrders} from "../../src/usd/UsdOrders.sol";
import {UsdFeeSplitter} from "../../src/usd/UsdFeeSplitter.sol";
import {MockUsdMigrator} from "./UsdCurve.t.sol";

contract GradCurveU {
    address public token;

    constructor(address t) {
        token = t;
    }

    function state() external pure returns (uint8) {
        return 2;
    }
}

contract TokU is ERC20 {
    constructor() ERC20("T", "T") {
        _mint(msg.sender, 1e30);
    }
}

/// Pool router stand-in: 1 token = `price` USDC-units per 1e18 tokens.
contract MockUsdRouter {
    uint256 public price = 1e6; // $1 per whole token
    TokU public tok;
    IERC20 public usdc;

    constructor(TokU t, IERC20 u) {
        tok = t;
        usdc = u;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function buy(address, uint256 usdcIn, uint256 minOut, address to, uint256) external returns (uint256 out) {
        usdc.transferFrom(msg.sender, address(this), usdcIn);
        out = (usdcIn * 1e18) / price;
        require(out >= minOut, "slip");
        tok.transfer(to, out);
    }

    function sell(address, uint256 amt, uint256 minOut, address to, uint256) external returns (uint256 out) {
        tok.transferFrom(msg.sender, address(this), amt);
        out = (amt * price) / 1e18;
        require(out >= minOut, "slip");
        usdc.transfer(to, out);
    }
}

contract UsdOrdersTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address whale = makeAddr("whale");
    TestUSDC usdc;
    UsdCurveFactory factory;
    UsdCurve curve;
    UsdToken token;
    UsdOrders orders;

    function setUp() public {
        usdc = new TestUSDC();
        factory = new UsdCurveFactory(
            owner,
            new MockUsdMigrator(IERC20(address(usdc))),
            operator,
            owner,
            UsdCurveFactory.Config({
                virtualNative: 1_000e6,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 50_000e6
            }),
            IERC20(address(usdc))
        );
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.prank(whale);
        (address c,,) = factory.launch("Cat", "CAT", "", "", "k", 0, 0, UsdCurve.FeeMode.Creator);
        curve = UsdCurve(c);
        token = curve.token();
        orders = new UsdOrders(IERC20(address(usdc)));
        deal(address(usdc), alice, 100_000e6);
        deal(address(usdc), whale, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(curve), type(uint256).max);
        vm.prank(whale);
        usdc.approve(address(curve), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(orders), type(uint256).max);
        vm.prank(alice);
        curve.buy(200e6, 0, alice);
    }

    function _whaleBuy(uint256 v) internal {
        vm.prank(whale);
        curve.buy(v, 0, whale);
    }

    function _whaleSell(uint256 amt) internal {
        vm.startPrank(whale);
        token.approve(address(curve), amt);
        curve.sell(amt, 0, whale);
        vm.stopPrank();
    }

    function _placeSell(uint256 amt, uint256 minOut, uint256 maxOut) internal returns (uint256 id) {
        vm.startPrank(alice);
        token.approve(address(orders), amt);
        id = orders.placeSell(address(curve), address(0), amt, minOut, maxOut, 0);
        vm.stopPrank();
    }

    function test_takeProfit_paysUsdc() public {
        uint256 amt = token.balanceOf(alice);
        uint256 target = curve.quoteSell(amt) * 2;
        uint256 id = _placeSell(amt, target, type(uint256).max);
        vm.expectRevert();
        orders.execute(id);
        _whaleBuy(1_500e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 out = orders.execute(id);
        assertGe(out, target);
        assertEq(usdc.balanceOf(alice) - before, out, "USDC went to alice");
        assertEq(token.balanceOf(address(orders)), 0);
        assertEq(usdc.balanceOf(address(orders)), 0);
    }

    function test_stopLoss_window() public {
        _whaleBuy(1_000e6);
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 stop = (v * 80) / 100;
        uint256 floor = (stop * 95) / 100;
        uint256 id = _placeSell(amt, floor, stop);
        vm.expectRevert();
        orders.execute(id);
        uint256 step = token.balanceOf(whale) / 50;
        while (curve.quoteSell(amt) > stop) _whaleSell(step);
        uint256 out = orders.execute(id);
        assertLe(out, stop);
        assertGe(out, floor);
    }

    function test_buyTheDip_escrowsUsdc_thenBuys() public {
        _whaleBuy(1_000e6);
        uint256 spend = 100e6;
        uint256 want = (curve.quoteBuy(spend) * 125) / 100;
        uint256 ub = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), spend, want, type(uint256).max, 0);
        assertEq(ub - usdc.balanceOf(alice), spend, "money set aside");
        assertEq(usdc.balanceOf(address(orders)), spend);
        vm.expectRevert();
        orders.execute(id);
        _whaleSell(token.balanceOf(whale) / 2);
        uint256 tb = token.balanceOf(alice);
        orders.execute(id);
        assertGe(token.balanceOf(alice) - tb, want);
        assertEq(usdc.balanceOf(address(orders)), 0);
    }

    function test_cancelBuy_refundsUsdc() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), 50e6, 1, type(uint256).max, 0);
        vm.prank(whale);
        vm.expectRevert(UsdOrders.NotOwner.selector);
        orders.cancel(id);
        uint256 ub = usdc.balanceOf(alice);
        vm.prank(alice);
        orders.cancel(id);
        assertEq(usdc.balanceOf(alice) - ub, 50e6);
        vm.expectRevert(UsdOrders.NotOpen.selector);
        orders.execute(id);
    }

    function test_soldOut_unspentUsdcReturned() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), 90_000e6, 1, type(uint256).max, 0);
        uint256 ub = usdc.balanceOf(alice);
        orders.execute(id);
        assertEq(curve.tokensForSale(), 0);
        assertGt(usdc.balanceOf(alice), ub, "unspent USDC back to alice");
        assertEq(usdc.balanceOf(address(orders)), 0);
        assertEq(usdc.allowance(address(orders), address(curve)), 0, "no allowance left behind");
    }

    function test_graduated_throughRouter() public {
        TokU t = new TokU();
        MockUsdRouter r = new MockUsdRouter(t, IERC20(address(usdc)));
        t.transfer(address(r), 1e28);
        deal(address(usdc), address(r), 1_000_000e6);
        GradCurveU g = new GradCurveU(address(t));
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(g), address(r), 100e6, 150 ether, type(uint256).max, 0);
        vm.expectRevert();
        orders.execute(id);
        r.setPrice(0.5e6);
        orders.execute(id);
        assertEq(t.balanceOf(alice), 200 ether);
        // and a take profit on those coins
        vm.startPrank(alice);
        t.approve(address(orders), 200 ether);
        uint256 s = orders.placeSell(address(g), address(r), 200 ether, 300e6, type(uint256).max, 0);
        vm.stopPrank();
        vm.expectRevert();
        orders.execute(s);
        r.setPrice(2e6);
        uint256 ub = usdc.balanceOf(alice);
        orders.execute(s);
        assertEq(usdc.balanceOf(alice) - ub, 400e6);
    }

    function testFuzz_sellNeverOutsideWindow(uint96 up, uint96 down, uint16 minPct, uint16 span) public {
        uint256 u = bound(up, 0, 2_000e6);
        if (u >= 1e6) _whaleBuy(u);
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 lo = (v * bound(minPct, 10, 300)) / 100;
        uint256 hi = lo + (v * bound(span, 0, 300)) / 100;
        uint256 id = _placeSell(amt, lo, hi);
        uint256 d = bound(down, 0, token.balanceOf(whale));
        // USDC has 6 decimals: a sell worth less than $0.000001 is refused by the
        // curve (ZeroAmount), exactly like any dust sell; skip those.
        if (d > 0 && curve.quoteSell(d) > 0) _whaleSell(d);
        try orders.execute(id) returns (uint256 out) {
            assertGe(out, lo);
            assertLe(out, hi);
        } catch {
            (,,,,, bool open,,,,) = orders.orders(id);
            assertTrue(open);
        }
    }
}

contract UsdFeeSplitterTest is Test {
    TestUSDC usdc;
    UsdFeeSplitter s;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address rewards = makeAddr("rewards");

    function setUp() public {
        usdc = new TestUSDC();
        s = new UsdFeeSplitter(owner, treasury, rewards, 3_000, IERC20(address(usdc)));
    }

    function test_splits30_70() public {
        deal(address(usdc), address(s), 1_000e6);
        (uint256 t, uint256 r) = s.distribute();
        assertEq(r, 300e6);
        assertEq(t, 700e6);
        assertEq(usdc.balanceOf(rewards), 300e6);
        assertEq(usdc.balanceOf(treasury), 700e6);
    }

    function testFuzz_noDustLost(uint64 amt) public {
        deal(address(usdc), address(s), amt);
        (uint256 t, uint256 r) = s.distribute();
        assertEq(t + r, amt);
        assertEq(usdc.balanceOf(address(s)), 0);
    }

    function test_onlyOwner_andCap() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        s.setRewards(address(1));
        vm.prank(owner);
        vm.expectRevert(UsdFeeSplitter.ShareTooHigh.selector);
        s.setRewardsBps(5_001);
    }

    function test_curveFeesLandInSplitter() public {
        UsdCurveFactory f = new UsdCurveFactory(
            owner,
            new MockUsdMigrator(IERC20(address(usdc))),
            owner,
            address(s),
            UsdCurveFactory.Config({
                virtualNative: 1_000e6,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 1_000e6
            }),
            IERC20(address(usdc))
        );
        vm.prank(owner);
        f.setLaunchesOpen(true);
        address u = makeAddr("u");
        deal(address(usdc), u, 1_000e6);
        vm.startPrank(u);
        usdc.approve(address(f), type(uint256).max);
        (address c,,) = f.launch("A", "A", "", "", "k", 500e6, 0, UsdCurve.FeeMode.Creator);
        vm.stopPrank();
        uint256 fees = UsdCurve(c).protocolFees();
        UsdCurve(c).claimProtocolFees();
        assertEq(usdc.balanceOf(address(s)), fees);
        s.distribute();
        assertEq(usdc.balanceOf(rewards), (fees * 3_000) / 10_000);
    }
}
