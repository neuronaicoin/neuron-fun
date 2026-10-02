// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SasaBoost} from "../../src/omni/SasaBoost.sol";
import {USDC6} from "./UsdCurveV6.t.sol";

contract SasaBoostTest is Test {
    USDC6 usd;
    SasaBoost b;
    address treasury = address(0x7EA5);
    address admin = address(0xAD);
    address alice = address(0xA11CE);
    address coin = address(0xC01);

    function setUp() public {
        usd = new USDC6();
        b = new SasaBoost(usd, treasury, admin);
        usd.mint(alice, 100e6);
        vm.prank(alice);
        usd.approve(address(b), type(uint256).max);
    }

    function test_pays_treasury_andSetsTime() public {
        vm.prank(alice);
        uint64 until = b.boost(coin, 0);
        assertEq(usd.balanceOf(treasury), 10e6);
        assertEq(until, block.timestamp + 6 hours);
        assertEq(b.boostedUntil(coin), until);
    }

    function test_timeAddsUp_thenRestartsAfterExpiry() public {
        vm.startPrank(alice);
        b.boost(coin, 0); // 6h
        b.boost(coin, 1); // +24h
        assertEq(b.boostedUntil(coin), block.timestamp + 30 hours);
        vm.warp(block.timestamp + 31 hours);
        b.boost(coin, 0);
        assertEq(b.boostedUntil(coin), block.timestamp + 6 hours);
        vm.stopPrank();
        assertEq(usd.balanceOf(treasury), 40e6);
    }

    function test_badPlan_andOwnerOnlySettings() public {
        vm.prank(alice);
        vm.expectRevert(SasaBoost.BadPlan.selector);
        b.boost(coin, 2);
        vm.expectRevert();
        b.setPlan(0, 1, 1);
        vm.prank(admin);
        b.setPlan(2, 50e6, 3 days);
        assertEq(b.plansCount(), 3);
        vm.prank(admin);
        b.setPlan(0, 10e6, 0); // retired
        vm.prank(alice);
        vm.expectRevert(SasaBoost.BadPlan.selector);
        b.boost(coin, 0);
    }

    function test_noMoney_noBoost() public {
        address bob = address(0xB0B);
        vm.prank(bob);
        vm.expectRevert();
        b.boost(coin, 0);
        assertEq(b.boostedUntil(coin), 0);
    }
}
