// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CurveToken
 * @notice Fixed-supply coin with optional native-coin rewards for holders.
 *
 * Anyone can send native coin to `distribute()`; it is shared among holders
 * in proportion to their balance at that moment, and each holder claims their
 * part whenever they like. Accounting follows the well-known "magnified
 * dividend" pattern: no loops, no snapshots, exact up to rounding dust that
 * stays in the contract.
 *
 * Addresses that hold coins on behalf of everyone (the curve, the pool
 * manager, the migrator, the burn address) are excluded, so rewards only go to
 * real holders. The exclusion list is fixed at creation. No owner, no minting.
 *
 * Rewards wait (in `pendingRewards`) until holders own at least
 * MIN_SHARES between them, so a dust holder can never capture a whole
 * distribution or push the accounting toward overflow.
 */
contract CurveToken is ERC20, ReentrancyGuard {
    uint256 private constant MAGNITUDE = 2 ** 128;
    /// @notice 0.1% of the supply must be in holders' hands before rewards are shared.
    uint256 public constant MIN_SHARES = 1_000_000 ether;

    string public logo;
    string public description;

    /// @notice Addresses that never earn rewards (fixed at creation).
    mapping(address => bool) public excluded;
    /// @notice Sum of balances that earn rewards.
    uint256 public rewardShares;
    /// @notice Native coin waiting for enough holders; added to the next distribution.
    uint256 public pendingRewards;
    /// @notice Everything ever shared among holders.
    uint256 public totalDistributed;

    uint256 private _perShare;
    mapping(address => int256) private _corrections;
    mapping(address => uint256) private _claimed;

    event RewardsDistributed(address indexed from, uint256 amount);
    event RewardsClaimed(address indexed holder, address indexed to, uint256 amount);

    error ClaimFailed();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        uint256 supply,
        address to,
        address[] memory excludedAccounts
    ) ERC20(name_, symbol_) {
        logo = logo_;
        description = description_;
        excluded[address(0)] = true;
        excluded[to] = true;
        for (uint256 i; i < excludedAccounts.length; ++i) {
            excluded[excludedAccounts[i]] = true;
        }
        _mint(to, supply);
    }

    /// @notice Shares `msg.value` (plus anything waiting) among current holders.
    function distribute() external payable {
        uint256 amount = msg.value + pendingRewards;
        if (amount == 0) return;
        if (rewardShares < MIN_SHARES) {
            pendingRewards = amount;
            return;
        }
        pendingRewards = 0;
        _perShare += (amount * MAGNITUDE) / rewardShares;
        totalDistributed += amount;
        emit RewardsDistributed(msg.sender, amount);
    }

    /// @notice What `holder` can claim right now.
    function claimable(address holder) public view returns (uint256) {
        return earned(holder) - _claimed[holder];
    }

    /// @notice Everything `holder` has earned so far, claimed or not.
    function earned(address holder) public view returns (uint256) {
        if (excluded[holder]) return 0;
        int256 magnified = int256(_perShare * balanceOf(holder)) + _corrections[holder];
        return magnified <= 0 ? 0 : uint256(magnified) / MAGNITUDE;
    }

    /// @notice Sends the caller's rewards to `to`.
    function claim(address to) external nonReentrant returns (uint256 amount) {
        amount = claimable(msg.sender);
        if (amount == 0) return 0;
        _claimed[msg.sender] += amount;
        emit RewardsClaimed(msg.sender, to, amount);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert ClaimFailed();
    }

    /// @dev Keeps every holder's earned rewards unchanged when balances move.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        int256 magnified = int256(_perShare * value);
        if (!excluded[from]) {
            _corrections[from] += magnified;
            rewardShares -= value;
        }
        if (!excluded[to]) {
            _corrections[to] -= magnified;
            rewardShares += value;
        }
    }
}
