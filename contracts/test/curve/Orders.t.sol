// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {SasaOrders} from "../../src/curve/SasaOrders.sol";
import {MockMigrator} from "./NeuronCurve.t.sol";

/// A graduated coin: its curve reports "graduated" and trading goes through a router.
contract GradCurve {
    address public token;

    constructor(address t) {
        token = t;
    }

    function state() external pure returns (uint8) {
        return 2;
    }
}

contract Tok is ERC20 {
    constructor() ERC20("T", "T") {
        _mint(msg.sender, 1e30);
    }
}

/// Pool router stand-in: 1 token = `price` wei, both ways.
contract MockRouter {
    uint256 public price = 1e9;
    Tok public tok;

    constructor(Tok t) {
        tok = t;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function buy(address, uint256 minOut, address to, uint256) external payable returns (uint256 out) {
        out = (msg.value * 1e18) / price;
        require(out >= minOut, "slip");
        tok.transfer(to, out);
    }

    function sell(address, uint256 amt, uint256 minOut, address to, uint256) external returns (uint256 out) {
        tok.transferFrom(msg.sender, address(this), amt);
        out = (amt * price) / 1e18;
        require(out >= minOut, "slip");
        (bool ok,) = to.call{value: out}("");
        require(ok);
    }

    receive() external payable {}
}

contract OrdersTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice"); // the order owner
    address whale = makeAddr("whale"); // moves the price
    address keeper = makeAddr("keeper");
    NeuronCurveFactory factory;
    NeuronCurve curve;
    CurveToken token;
    SasaOrders orders;

    function setUp() public {
        factory = new NeuronCurveFactory(
            owner,
            new MockMigrator(),
            operator,
            owner,
            NeuronCurveFactory.Config({
                virtualNative: 1 ether,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 50 ether
            })
        );
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.deal(alice, 100 ether);
        vm.deal(whale, 1_000 ether);
        vm.prank(whale);
        (address c,,) = factory.launch("Cat", "CAT", "", "", "k", 0, NeuronCurve.FeeMode.Creator);
        curve = NeuronCurve(payable(c));
        token = curve.token();
        orders = new SasaOrders();
        // alice holds some coins
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, alice);
    }

    function _whaleBuy(uint256 v) internal {
        vm.prank(whale);
        curve.buy{value: v}(0, whale);
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

    // ------------------------------------------------------------ take profit

    function test_takeProfit_waitsThenFills() public {
        uint256 amt = token.balanceOf(alice);
        uint256 now_ = curve.quoteSell(amt);
        uint256 target = now_ * 2; // +100%
        uint256 id = _placeSell(amt, target, type(uint256).max);

        vm.prank(keeper);
        vm.expectRevert(); // not there yet
        orders.execute(id);

        _whaleBuy(10 ether);
        assertGe(curve.quoteSell(amt), target, "price went up");
        uint256 before = alice.balance;
        vm.prank(keeper);
        uint256 out = orders.execute(id);
        assertGe(out, target);
        assertEq(alice.balance - before, out, "money went to alice, not the keeper");
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(address(orders)), 0, "nothing stuck here");
        (,,,,, bool open,,,,) = orders.orders(id);
        assertFalse(open);
        vm.expectRevert(SasaOrders.NotOpen.selector);
        orders.execute(id);
    }

    // ------------------------------------------------------------ stop loss

    function test_stopLoss_onlyFillsInsideWindow() public {
        _whaleBuy(1 ether);
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 stop = (v * 80) / 100; // -20%
        uint256 floor = (stop * 95) / 100; // 5% slippage allowed
        uint256 id = _placeSell(amt, floor, stop);

        vm.prank(keeper);
        vm.expectRevert(); // price still high: the keeper can't sell early
        orders.execute(id);

        // price falls, bit by bit, into the window
        uint256 step = token.balanceOf(whale) / 50;
        while (curve.quoteSell(amt) > stop) _whaleSell(step);
        uint256 q = curve.quoteSell(amt);
        assertLe(q, stop);
        assertGe(q, floor);
        vm.prank(keeper);
        uint256 out = orders.execute(id);
        assertLe(out, stop);
        assertGe(out, floor);
    }

    function test_stopLoss_crashBelowFloor_staysOpen() public {
        _whaleBuy(1 ether);
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 id = _placeSell(amt, (v * 76) / 100, (v * 80) / 100);
        _whaleSell(token.balanceOf(whale)); // crash
        assertLt(curve.quoteSell(amt), (v * 76) / 100);
        vm.expectRevert();
        orders.execute(id);
        (,,,,, bool open,,,,) = orders.orders(id);
        assertTrue(open, "still waiting for a price inside the window");
    }

    // ------------------------------------------------------------ buy the dip

    function test_buyTheDip_holdsMoneyThenBuys() public {
        _whaleBuy(1 ether);
        uint256 spend = 0.1 ether;
        uint256 nowTokens = curve.quoteBuy(spend);
        uint256 want = (nowTokens * 125) / 100; // price -20% => 1/0.8 = +25% tokens
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: spend}(address(curve), address(0), want, type(uint256).max, 0);
        assertEq(address(orders).balance, spend, "money set aside");

        vm.expectRevert();
        orders.execute(id);

        _whaleSell(token.balanceOf(whale) / 2);
        assertGe(curve.quoteBuy(spend), want);
        uint256 before = token.balanceOf(alice);
        orders.execute(id);
        assertGe(token.balanceOf(alice) - before, want, "alice got the coins");
        assertEq(address(orders).balance, 0);
    }

    function test_cancelBuy_refunds() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: 2 ether}(address(curve), address(0), 1, type(uint256).max, 0);
        vm.prank(whale);
        vm.expectRevert(SasaOrders.NotOwner.selector);
        orders.cancel(id);
        uint256 before = alice.balance;
        vm.prank(alice);
        orders.cancel(id);
        assertEq(alice.balance - before, 2 ether);
        vm.expectRevert(SasaOrders.NotOpen.selector);
        orders.execute(id);
    }

    function test_cancelSell_noRefundNeeded() public {
        uint256 id = _placeSell(1 ether, 1, type(uint256).max);
        vm.prank(alice);
        orders.cancel(id);
        vm.expectRevert(SasaOrders.NotOpen.selector);
        orders.execute(id);
    }

    function test_buyRefundWhenCurveSellsOut() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: 90 ether}(address(curve), address(0), 1, type(uint256).max, 0);
        uint256 before = alice.balance;
        orders.execute(id);
        assertEq(curve.tokensForSale(), 0, "sold out");
        assertGt(alice.balance, before, "unspent money came back to alice");
        assertEq(address(orders).balance, 0);
    }

    // ------------------------------------------------------------ partial / expiry / pause

    function test_soldSomeElsewhere_fillsTheRestAtTheSamePrice() public {
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 id = _placeSell(amt, v / 2, type(uint256).max); // easy target
        // alice sells half herself
        vm.startPrank(alice);
        token.approve(address(curve), amt / 2);
        curve.sell(amt / 2, 0, alice);
        vm.stopPrank();
        orders.execute(id);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_nothingLeftToSell_reverts() public {
        uint256 amt = token.balanceOf(alice);
        uint256 id = _placeSell(amt, 1, type(uint256).max);
        vm.prank(alice);
        token.transfer(whale, amt);
        vm.expectRevert(SasaOrders.NothingToSell.selector);
        orders.execute(id);
    }

    function test_takeProfitAndStopLoss_cantBothSell() public {
        uint256 amt = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(orders), amt); // one allowance covers the pair
        uint256 tp = orders.placeSell(address(curve), address(0), amt, 1, type(uint256).max, 0);
        uint256 sl = orders.placeSell(address(curve), address(0), amt, 1, type(uint256).max, 0);
        vm.stopPrank();
        orders.execute(tp);
        vm.expectRevert(SasaOrders.NothingToSell.selector);
        orders.execute(sl);
    }

    function test_expiry() public {
        vm.startPrank(alice);
        token.approve(address(orders), 1 ether);
        vm.expectRevert(SasaOrders.Expired.selector);
        orders.placeSell(address(curve), address(0), 1 ether, 1, type(uint256).max, uint64(block.timestamp));
        uint256 id = orders.placeSell(address(curve), address(0), 1 ether, 1, type(uint256).max, uint64(block.timestamp + 60));
        vm.stopPrank();
        vm.warp(block.timestamp + 61);
        vm.expectRevert(SasaOrders.Expired.selector);
        orders.execute(id);
    }

    function test_pausedBuys_orderWaits() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: 1 ether}(address(curve), address(0), 1, type(uint256).max, 0);
        vm.prank(owner);
        factory.pauseBuys();
        vm.expectRevert();
        orders.execute(id);
        (,,,,, bool open,,,,) = orders.orders(id);
        assertTrue(open);
    }

    function test_badOrdersRejected() public {
        vm.startPrank(alice);
        vm.expectRevert(SasaOrders.BadOrder.selector);
        orders.placeSell(address(curve), address(0), 0, 1, 2, 0);
        vm.expectRevert(SasaOrders.BadOrder.selector);
        orders.placeSell(address(curve), address(0), 1, 5, 4, 0);
        vm.expectRevert(SasaOrders.BadOrder.selector);
        orders.placeBuy(address(curve), address(0), 1, 2, 0);
        vm.stopPrank();
    }

    function test_ordersOf() public {
        uint256 a = _placeSell(1 ether, 1, type(uint256).max);
        uint256 b = _placeSell(1 ether, 1, type(uint256).max);
        uint256[] memory ids = orders.ordersOf(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], a);
        assertEq(ids[1], b);
    }

    // ------------------------------------------------------------ after graduation (router)

    function test_graduated_sellsThroughRouter() public {
        Tok t = new Tok();
        MockRouter r = new MockRouter(t);
        vm.deal(address(r), 100 ether);
        GradCurve g = new GradCurve(address(t));
        t.transfer(alice, 1_000 ether);
        vm.startPrank(alice);
        t.approve(address(orders), 1_000 ether);
        // 1000 tokens at 1 gwei = 1e-6 ETH... sell when worth >= 2e-6 ETH
        uint256 id = orders.placeSell(address(g), address(r), 1_000 ether, 2e12, type(uint256).max, 0);
        vm.stopPrank();
        vm.expectRevert();
        orders.execute(id);
        r.setPrice(3e9);
        uint256 before = alice.balance;
        orders.execute(id);
        assertEq(alice.balance - before, 3e12);
    }

    function test_graduated_buysThroughRouter() public {
        Tok t = new Tok();
        MockRouter r = new MockRouter(t);
        t.transfer(address(r), 5e27);
        GradCurve g = new GradCurve(address(t));
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: 1 ether}(address(g), address(r), 2e27, type(uint256).max, 0);
        vm.expectRevert();
        orders.execute(id);
        r.setPrice(4e8); // cheaper: 1 ETH buys 2.5e27
        orders.execute(id);
        assertEq(t.balanceOf(alice), 25e26);
    }

    function test_graduatedWithoutRouter_rejected() public {
        Tok t = new Tok();
        GradCurve g = new GradCurve(address(t));
        vm.prank(alice);
        uint256 id = orders.placeBuy{value: 1 ether}(address(g), address(0), 1, type(uint256).max, 0);
        vm.expectRevert(SasaOrders.BadOrder.selector);
        orders.execute(id);
    }

    // ------------------------------------------------------------ fuzz: never outside the window

    function testFuzz_sellNeverBelowMin(uint96 buyUp, uint96 sellDown, uint16 minPct, uint16 maxPct) public {
        uint256 up = bound(buyUp, 0, 1.5 ether);
        if (up < 0.001 ether) up = 0;
        if (up > 0) _whaleBuy(up);
        uint256 amt = token.balanceOf(alice);
        uint256 v = curve.quoteSell(amt);
        uint256 lo = (v * bound(minPct, 10, 300)) / 100;
        uint256 hi = lo + (v * bound(maxPct, 0, 300)) / 100;
        uint256 id = _placeSell(amt, lo, hi);
        uint256 down = bound(sellDown, 0, token.balanceOf(whale));
        if (down < 1 ether) down = 0;
        if (down > 0) _whaleSell(down);
        try orders.execute(id) returns (uint256 out) {
            assertGe(out, lo);
            assertLe(out, hi);
        } catch {
            (,,,,, bool open,,,,) = orders.orders(id);
            assertTrue(open);
        }
    }
}
