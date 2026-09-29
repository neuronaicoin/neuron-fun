// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SasaFeeSplitter} from "../../src/curve/SasaFeeSplitter.sol";
import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {MockMigrator} from "./NeuronCurve.t.sol";

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract ReenterSplitter {
    SasaFeeSplitter s;
    uint256 public tries;

    constructor(SasaFeeSplitter s_) {
        s = s_;
    }

    receive() external payable {
        if (tries++ == 0) {
            try s.distribute() {} catch {}
        }
    }
}

contract FeeSplitterTest is Test {
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address rewards = makeAddr("rewards");
    address alice = makeAddr("alice");
    SasaFeeSplitter s;

    function setUp() public {
        s = new SasaFeeSplitter(owner, treasury, rewards, 3_000);
        vm.deal(alice, 100 ether);
    }

    function test_splits_30_70() public {
        vm.prank(alice);
        (bool ok,) = address(s).call{value: 10 ether}("");
        assertTrue(ok);
        (uint256 t, uint256 r) = s.distribute();
        assertEq(r, 3 ether);
        assertEq(t, 7 ether);
        assertEq(rewards.balance, 3 ether);
        assertEq(treasury.balance, 7 ether);
        assertEq(address(s).balance, 0);
    }

    function test_distribute_emptyIsNoop() public {
        (uint256 t, uint256 r) = s.distribute();
        assertEq(t + r, 0);
    }

    function test_roundingNeverLosesWei(uint96 amount) public {
        vm.deal(address(s), amount);
        (uint256 t, uint256 r) = s.distribute();
        assertEq(t + r, amount);
        assertEq(address(s).balance, 0);
    }

    function test_anyoneCanDistribute() public {
        vm.deal(address(s), 1 ether);
        vm.prank(alice);
        s.distribute();
        assertEq(treasury.balance, 0.7 ether);
    }

    function test_onlyOwnerChangesSettings() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        s.setRewards(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        s.setTreasury(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        s.setRewardsBps(100);
        vm.stopPrank();
    }

    function test_shareCapped() public {
        vm.prank(owner);
        vm.expectRevert(SasaFeeSplitter.ShareTooHigh.selector);
        s.setRewardsBps(5_001);
        vm.expectRevert(SasaFeeSplitter.ShareTooHigh.selector);
        new SasaFeeSplitter(owner, treasury, rewards, 6_000);
    }

    function test_zeroAddressesRejected() public {
        vm.expectRevert(SasaFeeSplitter.ZeroAddress.selector);
        new SasaFeeSplitter(owner, address(0), rewards, 3_000);
        vm.startPrank(owner);
        vm.expectRevert(SasaFeeSplitter.ZeroAddress.selector);
        s.setRewards(address(0));
        vm.expectRevert(SasaFeeSplitter.ZeroAddress.selector);
        s.setTreasury(address(0));
        vm.stopPrank();
    }

    function test_rotateRewardsWallet() public {
        address r2 = makeAddr("r2");
        vm.prank(owner);
        s.setRewards(r2);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(r2.balance, 0.3 ether);
        assertEq(rewards.balance, 0);
    }

    function test_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(SasaFeeSplitter.RenounceDisabled.selector);
        s.renounceOwnership();
    }

    function test_failingRecipientRevertsWholeDistribute_moneyStays() public {
        Rejecter bad = new Rejecter();
        vm.prank(owner);
        s.setTreasury(address(bad));
        vm.deal(address(s), 1 ether);
        vm.expectRevert(SasaFeeSplitter.TransferFailed.selector);
        s.distribute();
        assertEq(address(s).balance, 1 ether, "nothing lost");
    }

    function test_reentrancyBlocked() public {
        ReenterSplitter re = new ReenterSplitter(s);
        vm.prank(owner);
        s.setRewards(address(re));
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(address(re).balance, 0.3 ether);
        assertEq(treasury.balance, 0.7 ether);
    }

    /// A coin's protocol fees can be paid into the splitter end to end.
    function test_curvePaysFeesIntoSplitter() public {
        NeuronCurveFactory f = new NeuronCurveFactory(
            owner,
            new MockMigrator(),
            owner,
            address(s),
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
        f.setLaunchesOpen(true);
        vm.prank(alice);
        (address curve,,) = f.launch{value: 1 ether}("A", "A", "", "", "k", 0, NeuronCurve.FeeMode.Creator);
        uint256 fees = NeuronCurve(payable(curve)).protocolFees();
        assertGt(fees, 0);
        NeuronCurve(payable(curve)).claimProtocolFees();
        assertEq(address(s).balance, fees);
        s.distribute();
        assertEq(rewards.balance, (fees * 3_000) / 10_000);
    }
}
