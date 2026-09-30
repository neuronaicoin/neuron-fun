// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UsdToken
 * @notice Fixed-supply sasa coin (v5, dollar edition). Holder rewards are
 * paid in USDC: anyone can call `distribute(amount)`, which pulls that much
 * USDC and shares it among holders by balance; each holder claims whenever
 * they like. Same "magnified dividend" accounting as v4, no loops.
 *
 * Accounts that hold coins for everyone (the curve, the pool manager, the
 * migrator, the burn address) are excluded. Rewards wait until holders own at
 * least MIN_SHARES between them. No owner, no minting.
 *
 * Optional creator lock: the creator's wallet can't send or sell this coin
 * until `lockedUntil` (at most MAX_LOCK after launch). Fixed at creation.
 */
contract UsdToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant MAGNITUDE = 2 ** 128;
    uint256 public constant MIN_SHARES = 1_000_000 ether;
    uint256 public constant MAX_LOCK = 1 days;

    IERC20 public immutable usdc;
    address public immutable lockedAccount;
    uint256 public immutable lockedUntil;

    string public logo;
    string public description;

    mapping(address => bool) public excluded;
    uint256 public rewardShares;
    uint256 public pendingRewards;
    uint256 public totalDistributed;

    uint256 private _perShare;
    mapping(address => int256) private _corrections;
    mapping(address => uint256) private _claimed;

    event RewardsDistributed(address indexed from, uint256 amount);
    event RewardsClaimed(address indexed holder, address indexed to, uint256 amount);

    error CreatorLocked(uint256 until);
    error LockTooLong();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        uint256 supply,
        address to,
        address[] memory excludedAccounts,
        address lockedAccount_,
        uint256 lockSeconds,
        IERC20 usdc_
    ) ERC20(name_, symbol_) {
        if (lockSeconds > MAX_LOCK) revert LockTooLong();
        if (lockSeconds > 0 && lockedAccount_ != address(0)) {
            lockedAccount = lockedAccount_;
            lockedUntil = block.timestamp + lockSeconds;
        }
        usdc = usdc_;
        logo = logo_;
        description = description_;
        excluded[address(0)] = true;
        excluded[to] = true;
        for (uint256 i; i < excludedAccounts.length; ++i) {
            excluded[excludedAccounts[i]] = true;
        }
        _mint(to, supply);
    }

    /// @notice Shares `amount` USDC (pulled from the caller) among holders.
    function distribute(uint256 amount) external nonReentrant {
        if (amount > 0) usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 total = amount + pendingRewards;
        if (total == 0) return;
        if (rewardShares < MIN_SHARES) {
            pendingRewards = total;
            return;
        }
        pendingRewards = 0;
        _perShare += (total * MAGNITUDE) / rewardShares;
        totalDistributed += total;
        emit RewardsDistributed(msg.sender, total);
    }

    function claimable(address holder) public view returns (uint256) {
        return earned(holder) - _claimed[holder];
    }

    function earned(address holder) public view returns (uint256) {
        if (excluded[holder]) return 0;
        int256 magnified = int256(_perShare * balanceOf(holder)) + _corrections[holder];
        return magnified <= 0 ? 0 : uint256(magnified) / MAGNITUDE;
    }

    function claim(address to) external nonReentrant returns (uint256 amount) {
        amount = claimable(msg.sender);
        if (amount == 0) return 0;
        _claimed[msg.sender] += amount;
        emit RewardsClaimed(msg.sender, to, amount);
        usdc.safeTransfer(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from == lockedAccount && block.timestamp < lockedUntil) revert CreatorLocked(lockedUntil);
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
