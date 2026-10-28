// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SasaDayPass} from "../src/SasaDayPass.sol";

contract SasaDayPassTest is Test {
    SasaDayPass p;
    address owner = address(0xA11CE);
    address alice = address(0xB0B);
    address bob = address(0xC0C);

    function setUp() public {
        vm.warp(1_000_000);
        p = new SasaDayPass(owner, "https://sasapad.fun/pass.json", 0);
    }

    function testMintOnePerWallet() public {
        vm.prank(alice);
        uint256 id = p.mint();
        assertEq(id, 1);
        assertEq(p.ownerOf(1), alice);
        assertEq(p.totalSupply(), 1);
        vm.prank(alice);
        vm.expectRevert("already minted");
        p.mint();
        // moving it on doesn't allow a second mint
        vm.prank(alice);
        p.transferFrom(alice, bob, 1);
        vm.prank(alice);
        vm.expectRevert("already minted");
        p.mint();
        vm.prank(bob);
        assertEq(p.mint(), 2);
        assertEq(p.tokenURI(2), "https://sasapad.fun/pass.json");
    }

    function testEndMintOnlyEarlierAndOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        p.endMint(uint64(block.timestamp + 10));
        vm.prank(owner);
        p.endMint(uint64(block.timestamp + 100));
        vm.prank(owner);
        vm.expectRevert("can only end earlier");
        p.endMint(uint64(block.timestamp + 200));
        vm.warp(block.timestamp + 101);
        vm.prank(alice);
        vm.expectRevert("mint closed");
        p.mint();
    }

    function testTimedEnd() public {
        SasaDayPass q = new SasaDayPass(owner, "u", uint64(block.timestamp + 50));
        vm.prank(alice);
        q.mint();
        vm.warp(block.timestamp + 51);
        vm.prank(bob);
        vm.expectRevert("mint closed");
        q.mint();
    }
}
