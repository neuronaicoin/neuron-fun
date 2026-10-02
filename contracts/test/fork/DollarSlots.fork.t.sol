// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Where the real dollars keep balances and allowances (storage slots). The site uses them to
 * simulate a trade before the approve is sent, so they must be right on mainnet:
 *   forge test --match-path "test/fork/DollarSlots*" -vv
 * Prints the mapping slots and checks them by writing through them.
 */
contract DollarSlotsFork is Test {
    using stdStorage for StdStorage;

    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function _slots(address token, string memory name) internal {
        address who = address(0xA11CE);
        address spender = address(0xB0B);
        uint256 balSlot = stdstore.target(token).sig(IERC20.balanceOf.selector).with_key(who).find();
        uint256 allowSlot = stdstore.target(token).sig(IERC20.allowance.selector).with_key(who).with_key(spender).find();
        // Recover the mapping's base slot by trying small bases.
        uint256 balBase = type(uint256).max;
        uint256 allowBase = type(uint256).max;
        for (uint256 b; b < 300; ++b) {
            if (uint256(keccak256(abi.encode(who, b))) == balSlot) balBase = b;
            if (uint256(keccak256(abi.encode(spender, keccak256(abi.encode(who, b))))) == allowSlot) allowBase = b;
        }
        console2.log(name);
        console2.log("  balances slot  ", balBase);
        console2.log("  allowances slot", allowBase);
        assertLt(balBase, 300, "balances base not found");
        assertLt(allowBase, 300, "allowances base not found");
        // Prove it: write through the slots and read back via the token.
        vm.store(token, bytes32(uint256(keccak256(abi.encode(who, balBase)))), bytes32(uint256(123e6)));
        assertEq(IERC20(token).balanceOf(who), 123e6);
        vm.store(token, keccak256(abi.encode(spender, keccak256(abi.encode(who, allowBase)))), bytes32(uint256(77e6)));
        assertEq(IERC20(token).allowance(who, spender), 77e6);
    }

    function test_base_usdc() public {
        vm.createSelectFork("base");
        _slots(BASE_USDC, "Base USDC");
    }

    function test_robinhood_usdg() public {
        vm.createSelectFork("robinhood");
        _slots(RH_USDG, "Robinhood USDG");
    }
}
