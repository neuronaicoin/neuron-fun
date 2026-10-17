// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SasaFeeVault, IHeldPayments as SasaFeeVaultHeld} from "../src/fees/SasaFeeVault.sol";

contract VaultToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// a dollar with a blocklist
contract BlockToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("BUSD", "BUSD") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function block_(address a) external {
        blocked[a] = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, v);
    }
}

/// a builder holding a payment for the vault
contract HeldBuilder {
    VaultToken public usdc;
    address public vault;

    constructor(VaultToken u, address v) {
        usdc = u;
        vault = v;
    }

    function claimHeld() external {
        require(msg.sender == vault, "not owed");
        usdc.mint(msg.sender, 50e6);
    }
}

/// a wallet that refuses the chain's coin
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/// tries to split again while being paid
contract Reenter {
    SasaFeeVault public v;

    function set(SasaFeeVault v_) external {
        v = v_;
    }

    receive() external payable {
        v.distribute();
    }
}

/// a sender that only allows 50,000 gas, like the race builders
contract GasLimitedSender {
    function pay(address to) external payable returns (bool ok) {
        (ok,) = to.call{value: msg.value, gas: 50_000}("");
    }
}

contract SasaFeeVaultTest is Test {
    VaultToken usdc;
    VaultToken coin;
    SasaFeeVault v;
    address keeper = address(0xBEE1);
    address rewards = address(0xBEE2);
    address treasury = address(0xBEE3);

    function setUp() public {
        usdc = new VaultToken("USDC");
        coin = new VaultToken("CAT");
        v = new SasaFeeVault(keeper, rewards, treasury, IERC20(address(usdc)));
    }

    function test_splitsNativeAndDollar() public {
        vm.deal(address(v), 1 ether);
        usdc.mint(address(v), 1_000e6);
        vm.prank(address(0xA11CE)); // anyone
        v.distribute();
        assertEq(keeper.balance, 0.1 ether);
        assertEq(rewards.balance, 0.1 ether);
        assertEq(treasury.balance, 0.8 ether);
        assertEq(usdc.balanceOf(keeper), 100e6);
        assertEq(usdc.balanceOf(rewards), 100e6);
        assertEq(usdc.balanceOf(treasury), 800e6);
        assertEq(address(v).balance, 0);
        assertEq(usdc.balanceOf(address(v)), 0);
    }

    function test_roundingLeavesNothing(uint96 n, uint96 d) public {
        vm.deal(address(v), n);
        usdc.mint(address(v), d);
        v.distribute();
        assertEq(address(v).balance, 0);
        assertEq(usdc.balanceOf(address(v)), 0);
        assertEq(keeper.balance + rewards.balance + treasury.balance, n);
        assertEq(usdc.balanceOf(keeper) + usdc.balanceOf(rewards) + usdc.balanceOf(treasury), d);
        assertGe(treasury.balance, (uint256(n) * 8) / 10);
    }

    function test_emptyIsFine() public {
        v.distribute();
        assertEq(treasury.balance, 0);
    }

    function test_receivesWithLittleGas() public {
        GasLimitedSender s = new GasLimitedSender();
        assertTrue(s.pay{value: 1 ether}(address(v)), "a 50k-gas payment lands");
        assertEq(address(v).balance, 1 ether);
    }

    function test_coinsGoToTreasuryInFull() public {
        coin.mint(address(v), 5e18);
        v.sweep(IERC20(address(coin)));
        assertEq(coin.balanceOf(treasury), 5e18);
        assertEq(coin.balanceOf(keeper), 0);
        vm.expectRevert(SasaFeeVault.NotSwept.selector);
        v.sweep(IERC20(address(usdc)));
    }

    function test_refusingKeeperForfeitsToTreasury() public {
        Refuser bad = new Refuser();
        vm.prank(treasury);
        v.setKeeper(address(bad));
        vm.deal(address(v), 1 ether);
        v.distribute();
        assertEq(rewards.balance, 0.1 ether);
        assertEq(treasury.balance, 0.9 ether, "the keeper's share went to the treasury");
    }

    function test_reentryBlocked() public {
        Reenter r = new Reenter();
        r.set(v);
        vm.prank(treasury);
        v.setRewards(address(r));
        vm.deal(address(v), 1 ether);
        v.distribute(); // the re-entry fails, so its share is forfeited to the treasury
        assertEq(address(r).balance, 0);
        assertEq(treasury.balance, 0.9 ether);
        assertEq(keeper.balance, 0.1 ether);
    }

    function test_onlyTreasuryChangesWallets() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        v.setKeeper(address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        v.setRewards(address(1));
        vm.startPrank(treasury);
        vm.expectRevert(SasaFeeVault.ZeroAddress.selector);
        v.setKeeper(address(0));
        vm.expectRevert(SasaFeeVault.ZeroAddress.selector);
        v.setRewards(address(0));
        vm.expectRevert(SasaFeeVault.RenounceDisabled.selector);
        v.renounceOwnership();
        v.setKeeper(address(0xC0DE));
        vm.stopPrank();
        assertEq(v.keeper(), address(0xC0DE));
        assertEq(v.treasury(), treasury, "the treasury never changes");
    }

    function test_blockedDollarWalletForfeitsToTreasury() public {
        BlockToken b = new BlockToken();
        SasaFeeVault w = new SasaFeeVault(keeper, rewards, treasury, IERC20(address(b)));
        b.block_(keeper);
        b.mint(address(w), 100e6);
        vm.deal(address(w), 1 ether);
        w.distribute();
        assertEq(b.balanceOf(rewards), 10e6);
        assertEq(b.balanceOf(treasury), 90e6, "the keeper's dollar share went to the treasury");
        assertEq(keeper.balance, 0.1 ether, "the coin side still paid the keeper");
    }

    function test_claimsHeldPayments() public {
        HeldBuilder hb = new HeldBuilder(usdc, address(v));
        v.claimHeld(SasaFeeVaultHeld(address(hb)));
        assertEq(usdc.balanceOf(address(v)), 50e6);
        v.distribute();
        assertEq(usdc.balanceOf(treasury), 40e6);
    }

    function test_constructorChecks() public {
        vm.expectRevert(SasaFeeVault.ZeroAddress.selector);
        new SasaFeeVault(address(0), rewards, treasury, IERC20(address(usdc)));
        vm.expectRevert(SasaFeeVault.ZeroAddress.selector);
        new SasaFeeVault(keeper, address(0), treasury, IERC20(address(usdc)));
        vm.expectRevert();
        new SasaFeeVault(keeper, rewards, address(0), IERC20(address(usdc)));
        vm.expectRevert(SasaFeeVault.ZeroAddress.selector);
        new SasaFeeVault(keeper, rewards, treasury, IERC20(address(0)));
    }
}
