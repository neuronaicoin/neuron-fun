// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {OmniOrders} from "../../src/omni/OmniOrders.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USDC6, FactoryStub, SinkStub} from "./UsdCurveV6.t.sol";

/// Router stand-in for a graduated (pool) coin: pays a fixed rate both ways.
contract PoolStub {
    USDC6 public usdc;
    LaunchCoin public coin;
    constructor(USDC6 u, LaunchCoin c) { usdc = u; coin = c; }
    function buy(address, uint256 usdcIn, uint256, address to, uint256) external returns (uint256 out) {
        usdc.transferFrom(msg.sender, address(this), usdcIn);
        out = usdcIn * 1e12 * 1000; // 1 USDC = 1000 coins
        coin.transfer(to, out);
    }
    function sell(address, uint256 amountIn, uint256, address to, uint256) external returns (uint256 out) {
        coin.transferFrom(msg.sender, address(this), amountIn);
        out = amountIn / 1e12 / 1000;
        usdc.mint(to, out);
    }
}

contract OmniOrdersTest is Test {
    USDC6 usdc;
    LaunchCoin coin;
    UsdCurveV6 curve;
    FactoryStub factory;
    OmniOrders orders;
    address hub = address(0x4B);
    address migrator;
    address alice = address(0xA11CE);

    function setUp() public {
        migrator = address(new SinkStub());
        usdc = new USDC6();
        factory = new FactoryStub();
        MockLzEndpoint ep = new MockLzEndpoint(1);
        coin = new LaunchCoin("Kedi", "KEDI", address(ep), 10, address(0x9407), address(0xC4EA), 0, address(this));
        curve = factory.deploy(
            UsdCurveV6.Params(usdc, coin, bytes32("kedi"), address(factory), hub, migrator, address(new SinkStub()), address(0xC4EA), address(0x9407), 50e6, 536_500_000 ether, 300_000_000 ether, 100, 3_000, UsdCurveV6.FeeMode.Creator)
        );
        coin.setController(address(curve));
        orders = new OmniOrders(usdc);
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(curve), type(uint256).max);
        usdc.approve(address(orders), type(uint256).max);
        coin.approve(address(orders), type(uint256).max);
        vm.stopPrank();
    }

    function test_buyOrderFillsOnTheCurve() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), 10e6, 1, type(uint256).max, 0);
        orders.execute(id);
        assertGt(coin.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(orders)), 0);
    }

    function test_sellOrderFillsOnTheCurve() public {
        vm.prank(alice);
        curve.buy(10e6, 0, alice);
        uint256 bal = coin.balanceOf(alice);
        vm.prank(alice);
        uint256 id = orders.placeSell(address(curve), address(0), bal, 1, type(uint256).max, 0);
        uint256 before = usdc.balanceOf(alice);
        orders.execute(id);
        assertEq(coin.balanceOf(alice), 0);
        assertGt(usdc.balanceOf(alice), before);
    }

    function test_frozen_waits_thenFillsAfterReopen() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), 5e6, 1, type(uint256).max, 0);
        vm.prank(hub);
        curve.freeze();
        vm.expectRevert(OmniOrders.NotNow.selector);
        orders.execute(id);
        vm.prank(hub);
        curve.reopen();
        orders.execute(id); // still open: fills now
        assertGt(coin.balanceOf(alice), 0);
    }

    function test_lostChain_neverFills_cancelRefunds() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0x1234), 5e6, 1, type(uint256).max, 0);
        vm.startPrank(hub);
        curve.freeze();
        curve.settle(7, false, 0, 0);
        vm.stopPrank();
        vm.expectRevert(OmniOrders.ChainLost.selector);
        orders.execute(id);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        orders.cancel(id);
        assertEq(usdc.balanceOf(alice), before + 5e6);
    }

    function test_wonChain_fillsInThePool() public {
        vm.prank(alice);
        curve.buy(10e6, 0, alice);
        PoolStub pool = new PoolStub(usdc, coin);
        vm.startPrank(hub);
        curve.freeze();
        curve.settle(7, true, 1_000 ether, 10e6);
        vm.stopPrank();
        deal(address(coin), address(pool), 1_000_000 ether);
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(pool), 2e6, 1, type(uint256).max, 0);
        uint256 before = coin.balanceOf(alice);
        orders.execute(id);
        assertEq(coin.balanceOf(alice) - before, 2_000 ether);
        // and a sell in the pool
        vm.prank(alice);
        uint256 s = orders.placeSell(address(curve), address(pool), 1_000 ether, 1, type(uint256).max, 0);
        uint256 u = usdc.balanceOf(alice);
        orders.execute(s);
        assertEq(usdc.balanceOf(alice) - u, 1e6);
    }

    function test_noRouterForPool_rejected() public {
        vm.prank(alice);
        uint256 id = orders.placeBuy(address(curve), address(0), 2e6, 1, type(uint256).max, 0);
        vm.startPrank(hub);
        curve.freeze();
        curve.settle(7, true, 0, 0);
        vm.stopPrank();
        vm.expectRevert(OmniOrders.BadOrder.selector);
        orders.execute(id);
    }
}
