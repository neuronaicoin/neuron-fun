// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAcrossSpokePool} from "../src/omni/AcrossUsdBridge.sol";
import {AutoOrders} from "../src/auto/AutoOrders.sol";
import {RaceCross, RaceCrossUsdc, IRaceRouter} from "../src/race/RaceCross.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {DecUsd} from "./AcrossUsdBridge.t.sol";
import {MockCoin, MockRouter} from "./RaceCross.t.sol";
import {CrossSpoke, ICrossMinter} from "./CrossSpoke.sol";

/// A whitelisted router gone bad: tries to take more than it was given, or returns nothing.
contract GreedyRouter {
    function grab(IERC20 t, address from, uint256 a) external {
        t.transferFrom(from, address(this), a);
    }

    function nothing() external {}
}

/// A coin that keeps 5% of every transfer, and a router that pays it out in full.
contract TaxCoin {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a - a / 20;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a - a / 20;
        return true;
    }
}

contract TaxRouter {
    function buy(IERC20 usd, TaxCoin c, uint256 usdIn, uint256 coinsOut) external {
        usd.transferFrom(msg.sender, address(this), usdIn);
        c.mint(msg.sender, coinsOut); // arrives untaxed: the tax bites on the way to the user
    }
}

/// A smart wallet that accepts no signature (ERC-1271 always says no).
contract NoSig {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

contract AutoOrdersTest is Test {
    DecUsd usd;
    MockCoin coin;
    MockRouter router;
    CrossSpoke spoke;
    AutoOrders ao;
    uint256 pk = 0xA11CE;
    address user;
    address keeper = address(0xBEEF);
    address feeTo = address(0xFEE);
    uint256 constant BASE = 8453;
    uint256 constant BNB = 56;

    function setUp() public {
        vm.chainId(BNB);
        usd = new DecUsd(6);
        coin = new MockCoin();
        router = new MockRouter(usd, coin);
        spoke = new CrossSpoke();
        ao = new AutoOrders(address(this), IERC20(address(usd)), IAcrossSpokePool(address(spoke)), BASE, IERC20(address(0xBA5E)), 6, feeTo);
        ao.setKeeper(keeper, true);
        ao.setRouter(address(router), true, true);
        user = vm.addr(pk);
        coin.mint(user, 1_000e6);
        usd.mint(user, 1_000e6);
        vm.startPrank(user);
        coin.approve(address(ao), type(uint256).max);
        usd.approve(address(ao), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers

    function _order(address tin, address tout, uint256 amt, uint256 minOut, uint8 mode) internal view returns (AutoOrders.Order memory o) {
        o = AutoOrders.Order(user, tin, tout, amt, minOut, mode, 0, 0, block.timestamp + 1 days, uint256(keccak256(abi.encode(tin, amt, minOut, mode))));
    }

    function _sign(AutoOrders.Order memory o, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ao.digest(o));
        return abi.encodePacked(r, s, v);
    }

    function _sellRoute(uint256 amt) internal view returns (AutoOrders.Route memory) {
        return AutoOrders.Route(address(router), address(router), abi.encodeCall(MockRouter.sell, (address(coin), amt, 0, address(ao), block.timestamp + 1)), 0);
    }

    function _buyRoute(uint256 amt) internal view returns (AutoOrders.Route memory) {
        return AutoOrders.Route(address(router), address(router), abi.encodeCall(MockRouter.buy, (address(coin), amt, 0, address(ao), block.timestamp + 1)), 0);
    }

    function _run(AutoOrders.Order memory o, bytes memory sig, AutoOrders.Route memory r) internal returns (uint256) {
        vm.prank(keeper);
        return ao.execute(o, sig, r);
    }

    function _empty() internal view {
        assertEq(usd.balanceOf(address(ao)), 0, "no dollars kept");
        assertEq(coin.balanceOf(address(ao)), 0, "no coins kept");
    }

    // ------------------------------------------------------------ take profit / stop loss

    function test_sellPaysUserMinusFee() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 99e6, 0);
        uint256 out = _run(o, _sign(o, pk), _sellRoute(100e6));
        assertEq(out, 100e6 - 100e3, "0.1% fee");
        assertEq(usd.balanceOf(user), 1_000e6 + out);
        assertEq(usd.balanceOf(feeTo), 100e3);
        assertEq(coin.balanceOf(user), 900e6);
        assertTrue(ao.used(user, o.nonce));
        _empty();
    }

    function test_belowMinimumNothingHappens() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 100e6, 0); // fee makes it 99.9
        bytes memory sig = _sign(o, pk);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AutoOrders.TooLittle.selector, 99_900_000, 100e6));
        ao.execute(o, sig, _sellRoute(100e6));
        assertFalse(ao.used(user, o.nonce), "still open, can run later");
        assertEq(coin.balanceOf(user), 1_000e6);
    }

    function test_onlyKeeperOnceBeforeDeadline() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 1, 0);
        bytes memory sig = _sign(o, pk);
        vm.expectRevert(AutoOrders.NotKeeper.selector);
        ao.execute(o, sig, _sellRoute(10e6));
        _run(o, sig, _sellRoute(10e6));
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.Used.selector);
        ao.execute(o, sig, _sellRoute(10e6));
        AutoOrders.Order memory late = _order(address(coin), address(usd), 11e6, 1, 0);
        bytes memory lateSig = _sign(late, pk);
        vm.warp(late.deadline + 1);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.Expired.selector);
        ao.execute(late, lateSig, _sellRoute(11e6));
    }

    /// An order with no minimum is never run (it would let any route through).
    function test_zeroMinimumRefused() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 0, 0);
        bytes memory sig = _sign(o, pk);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadOrder.selector);
        ao.execute(o, sig, _sellRoute(10e6));
        assertFalse(ao.used(user, o.nonce));
    }

    function test_cancel() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 1, 0);
        bytes memory sig = _sign(o, pk);
        vm.prank(user);
        ao.cancel(o.nonce);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.Used.selector);
        ao.execute(o, sig, _sellRoute(10e6));
    }

    function test_signatureCoversEveryField() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 9e6, 0);
        bytes memory sig = _sign(o, pk);
        bytes memory wrong = _sign(o, 0xBAD);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadSignature.selector);
        ao.execute(o, wrong, _sellRoute(10e6));
        AutoOrders.Order memory more = o;
        more.amountIn = 20e6;
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadSignature.selector);
        ao.execute(more, sig, _sellRoute(20e6));
        AutoOrders.Order memory lower = o;
        lower.minOut = 1;
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadSignature.selector);
        ao.execute(lower, sig, _sellRoute(10e6));
        AutoOrders.Order memory home = o;
        home.mode = 1;
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadSignature.selector);
        ao.execute(home, sig, _sellRoute(10e6));
        // another chain's signature doesn't work here
        vm.chainId(BASE);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadSignature.selector);
        ao.execute(o, sig, _sellRoute(10e6));
    }

    function test_userWith7702CodeStillSigns() public {
        vm.etch(user, abi.encodePacked(hex"ef0100", address(new NoSig())));
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 9e6, 0);
        _run(o, _sign(o, pk), _sellRoute(10e6));
        assertTrue(ao.used(user, o.nonce));
    }

    function test_soldSomeMeanwhileSellsWhatsLeft() public {
        vm.prank(user);
        coin.transfer(address(0xdead), 960e6); // 40 left
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 99e6, 0);
        uint256 out = _run(o, _sign(o, pk), _sellRoute(40e6));
        assertEq(coin.balanceOf(user), 0);
        assertEq(out, 40e6 - 40e3, "the minimum scaled to 40%: 39.6, got 39.96");
        _empty();
    }

    function test_routerUsingHalfReturnsTheRest() public {
        router.setPartial(true);
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 49e6, 0);
        uint256 out = _run(o, _sign(o, pk), _sellRoute(100e6));
        assertEq(out, 50e6 - 50e3);
        assertEq(coin.balanceOf(user), 950e6, "unsold half back");
        _empty();
        // a dip buy with a half-filling router: unused dollars back, fee still 0.1% of the order
        AutoOrders.Order memory b = _order(address(usd), address(coin), 100e6, 1, 0);
        uint256 usdBefore = usd.balanceOf(user);
        _run(b, _sign(b, pk), _buyRoute(99_900_000));
        assertEq(usdBefore - usd.balanceOf(user), 100e6 - (99_900_000 - 99_900_000 / 2), "paid only what was used + fee");
        _empty();
    }

    // ------------------------------------------------------------ attacks

    function test_routerMustBeAllowed() public {
        GreedyRouter g = new GreedyRouter();
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 1, 0);
        bytes memory sig = _sign(o, pk);
        // a keeper pointing the call at a token to move someone's approved coins: refused
        AutoOrders.Route memory steal =
            AutoOrders.Route(address(0), address(coin), abi.encodeCall(IERC20.transferFrom, (user, keeper, 900e6)), 0);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.RouterNotAllowed.selector);
        ao.execute(o, sig, steal);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.RouterNotAllowed.selector);
        ao.execute(o, sig, AutoOrders.Route(address(0), address(g), abi.encodeCall(GreedyRouter.nothing, ()), 0));
        vm.expectRevert(AutoOrders.BadConfig.selector);
        ao.setRouter(address(usd), true, true);
    }

    function test_badRouterCantTakeMoreOrPayLess() public {
        GreedyRouter g = new GreedyRouter();
        ao.setRouter(address(g), true, true);
        AutoOrders.Order memory o = _order(address(coin), address(usd), 10e6, 1, 0);
        bytes memory sig = _sign(o, pk);
        // tries to pull more than the order from the contract: the approval is only the order's amount
        vm.prank(keeper);
        vm.expectRevert();
        ao.execute(o, sig, AutoOrders.Route(address(g), address(g), abi.encodeCall(GreedyRouter.grab, (IERC20(address(coin)), address(ao), 11e6)), 0));
        // tries to pull from the user directly: the user approved AutoOrders, not the router
        vm.prank(keeper);
        vm.expectRevert();
        ao.execute(o, sig, AutoOrders.Route(address(g), address(g), abi.encodeCall(GreedyRouter.grab, (IERC20(address(coin)), user, 1)), 0));
        // takes the coins and pays nothing: below the minimum, so nothing happens
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AutoOrders.TooLittle.selector, 0, 1));
        ao.execute(o, sig, AutoOrders.Route(address(g), address(g), abi.encodeCall(GreedyRouter.grab, (IERC20(address(coin)), address(ao), 10e6)), 0));
        assertEq(coin.balanceOf(user), 1_000e6, "nothing lost");
    }

    function test_oneSideIsAlwaysTheDollar() public {
        MockCoin other = new MockCoin();
        AutoOrders.Order memory o = _order(address(coin), address(other), 10e6, 1, 0);
        bytes memory sig = _sign(o, pk);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadOrder.selector);
        ao.execute(o, sig, _sellRoute(10e6));
    }

    // ------------------------------------------------------------ buy the dip

    function test_dipBuy() public {
        AutoOrders.Order memory o = _order(address(usd), address(coin), 50e6, 49e6, 0);
        uint256 out = _run(o, _sign(o, pk), _buyRoute(50e6 - 50e3));
        assertEq(out, 50e6 - 50e3, "coins for the dollars after the fee");
        assertEq(coin.balanceOf(user), 1_000e6 + out);
        assertEq(usd.balanceOf(user), 950e6);
        assertEq(usd.balanceOf(feeTo), 50e3);
        _empty();
    }

    // ------------------------------------------------------------ dollars home / buys on other chains

    function test_sellHomeSendsToBase() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 99e6, 1);
        o.maxRouteFee = 1e6;
        bytes memory sig = _sign(o, pk);
        AutoOrders.Route memory r = _sellRoute(100e6);
        r.routeFee = 2e6;
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.RouteFeeTooHigh.selector);
        ao.execute(o, sig, r);
        r.routeFee = 30e3;
        uint256 out = _run(o, sig, r);
        assertEq(spoke.lastDepositor(), user, "the user is the depositor (refunds go to them)");
        assertEq(spoke.lastRecipient(), user);
        assertEq(spoke.lastDst(), BASE);
        assertEq(spoke.lastInput(), out);
        assertEq(spoke.lastOutput(), out - 30e3);
        assertEq(usd.balanceOf(user), 1_000e6, "nothing paid out here");
        _empty();
    }

    function test_taxedCoinMustStillReachTheUserInFull() public {
        TaxCoin tc = new TaxCoin();
        TaxRouter tr = new TaxRouter();
        ao.setRouter(address(tr), true, true);
        AutoOrders.Order memory o = _order(address(usd), address(tc), 50e6, 49e6, 0);
        bytes memory sig = _sign(o, pk);
        AutoOrders.Route memory r = AutoOrders.Route(address(tr), address(tr), abi.encodeCall(TaxRouter.buy, (IERC20(address(usd)), tc, 50e6 - 50e3, 50e6)), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AutoOrders.TooLittle.selector, 47_500_000, 49e6)); // 5% taxed on the way out
        ao.execute(o, sig, r);
        assertEq(usd.balanceOf(user), 1_000e6, "nothing spent");
        // a minimum the taxed amount meets: runs, and the reported amount is what arrived
        o.minOut = 47e6;
        o.nonce = 2;
        uint256 out = _run(o, _sign(o, pk), r);
        assertEq(out, 47_500_000);
        assertEq(tc.balanceOf(user), 47_500_000);
    }

    function test_sellHomeOnlyForKeysAndSasaAccounts() public {
        AutoOrders.Order memory o = _order(address(coin), address(usd), 100e6, 99e6, 1);
        o.maxRouteFee = 1e6;
        AutoOrders.Route memory r = _sellRoute(100e6);
        r.routeFee = 30e3;
        // a contract wallet: its address on Base may not be theirs
        vm.etch(user, address(new NoSig()).code);
        bytes memory sig = _sign(o, pk);
        vm.prank(keeper);
        vm.expectRevert(AutoOrders.BadOrder.selector);
        ao.execute(o, sig, r);
        // a sasa account (EIP-7702 delegation): fine
        vm.etch(user, abi.encodePacked(hex"ef0100", address(0x7702)));
        _run(o, sig, r);
        assertEq(spoke.lastRecipient(), user);
        _empty();
    }

    function test_rescueOnlyOwner() public {
        usd.mint(address(ao), 5e6);
        vm.prank(keeper);
        vm.expectRevert();
        ao.rescue(IERC20(address(usd)), keeper, 5e6);
        ao.rescue(IERC20(address(usd)), address(0xCAFE), 5e6);
        assertEq(usd.balanceOf(address(0xCAFE)), 5e6);
    }

    function test_dipBuyOnAnotherChainThroughRaceCross() public {
        // this AutoOrders acts as Base's; BNB Chain's RaceCross buys (an Arc-like RaceCross here)
        vm.chainId(BASE);
        AutoOrders base = new AutoOrders(address(this), IERC20(address(usd)), IAcrossSpokePool(address(spoke)), BASE, IERC20(address(usd)), 6, feeTo);
        base.setKeeper(keeper, true);
        DecUsd bnbUsd = new DecUsd(18);
        MockCoin bnbCoin = new MockCoin();
        MockRouter bnbRouter = new MockRouter(bnbUsd, bnbCoin);
        RaceCrossUsdc x = new RaceCrossUsdc(spoke, IERC20(address(bnbUsd)), IRaceRouter(address(bnbRouter)), RaceFactory(address(0)), BASE, IERC20(address(usd)), 6, 0);
        base.setCrossRoute(BNB, AutoOrders.CrossRoute(address(x), address(bnbUsd), 18, 0));
        vm.expectRevert(AutoOrders.RouteFixed.selector);
        base.setCrossRoute(BNB, AutoOrders.CrossRoute(address(0xBAD), address(bnbUsd), 18, 0));
        vm.prank(user);
        usd.approve(address(base), type(uint256).max);

        AutoOrders.Order memory o = AutoOrders.Order(user, address(usd), address(bnbCoin), 20e6, 19e18, 2, BNB, 1e6, block.timestamp + 1 days, 7);
        (uint8 v, bytes32 r_, bytes32 s_) = vm.sign(pk, base.digest(o));
        vm.prank(keeper);
        base.execute(o, abi.encodePacked(r_, s_, v), AutoOrders.Route(address(0), address(0), "", 50e3));
        uint256 sent = 20e6 - 20e3;
        assertEq(spoke.lastRecipient(), address(x));
        assertEq(spoke.lastDepositor(), user);
        assertEq(spoke.lastOutput(), (sent - 50e3) * 1e12, "18 decimals there");
        assertEq(usd.balanceOf(feeTo), 20e3);
        // Across delivers: RaceCross buys for the user, at least minOut coins
        vm.chainId(BNB);
        spoke.fill(address(bnbUsd), ICrossMinter(address(bnbUsd)), address(x), spoke.lastOutput(), _lastMessage(o, x));
        assertEq(bnbCoin.balanceOf(user), (sent - 50e3) * 1e12);
    }

    /// The message AutoOrders built, rebuilt the same way (CrossSpoke doesn't keep it).
    function _lastMessage(AutoOrders.Order memory o, RaceCrossUsdc) internal view returns (bytes memory) {
        return abi.encode(uint8(0), abi.encode(RaceCross.Order(o.user, o.tokenOut, o.minOut, 0, block.timestamp + 4 hours)));
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the amounts and the router's behaviour: the user gets at least the minimum or
    /// nothing moves, the fee is exactly 0.1%, and the contract keeps nothing.
    function testFuzz_invariants(uint96 amt, uint96 minOut, bool half, bool sell) public {
        uint256 a = bound(uint256(amt), 1e3, 900e6);
        uint256 m = bound(uint256(minOut), 1, a);
        router.setPartial(half);
        AutoOrders.Order memory o = sell ? _order(address(coin), address(usd), a, m, 0) : _order(address(usd), address(coin), a, m, 0);
        bytes memory sig = _sign(o, pk);
        uint256 coinBefore = coin.balanceOf(user);
        uint256 usdBefore = usd.balanceOf(user);
        AutoOrders.Route memory r = sell ? _sellRoute(a) : _buyRoute(a - (a * 10) / 10_000);
        vm.prank(keeper);
        try ao.execute(o, sig, r) returns (uint256 out) {
            assertGe(out, m, "at least the minimum");
            if (sell) assertEq(usd.balanceOf(user) - usdBefore, out);
            else assertEq(coin.balanceOf(user) - coinBefore, out);
            assertTrue(ao.used(user, o.nonce));
        } catch {
            assertEq(coin.balanceOf(user), coinBefore, "nothing moved");
            assertEq(usd.balanceOf(user), usdBefore);
            assertFalse(ao.used(user, o.nonce));
        }
        _empty();
    }
}
