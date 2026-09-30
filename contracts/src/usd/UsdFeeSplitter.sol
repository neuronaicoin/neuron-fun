// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SasaFeeSplitter
 * @notice Where sasa's share of trading fees (USDC) lands. It keeps the money until
 * anyone calls `distribute()`, which sends `rewardsBps` of it to the rewards
 * wallet (the wallet that pays referral and copy-trading rewards every day)
 * and the rest to the treasury (a Safe at mainnet).
 *
 * Receiving never forwards anything, so a coin paying its fees here can't be
 * blocked by the treasury or the rewards wallet. Only the owner (the Safe)
 * can change the two addresses or the split, and the rewards share is capped.
 */
/// @dev USD edition (v5): the fees arriving here are USDC, and so are the payouts.
contract UsdFeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The money this splitter shares out (USDC).
    IERC20 public immutable usdc;
    uint256 public constant BPS = 10_000;
    /// @notice The rewards wallet never gets more than half.
    uint256 public constant MAX_REWARDS_BPS = 5_000;

    address public treasury;
    address public rewards;
    uint16 public rewardsBps;

    event Distributed(uint256 toTreasury, uint256 toRewards);
    event TreasurySet(address treasury);
    event RewardsSet(address rewards);
    event RewardsBpsSet(uint16 bps);

    error ZeroAddress();
    error ShareTooHigh();
    error TransferFailed();
    error RenounceDisabled();

    constructor(address owner_, address treasury_, address rewards_, uint16 rewardsBps_, IERC20 usdc_) Ownable(owner_) {
        if (treasury_ == address(0) || rewards_ == address(0) || address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        if (rewardsBps_ > MAX_REWARDS_BPS) revert ShareTooHigh();
        treasury = treasury_;
        rewards = rewards_;
        rewardsBps = rewardsBps_;
    }

    /// @notice Splits everything held right now. Anyone can call it.
    function distribute() external nonReentrant returns (uint256 toTreasury, uint256 toRewards) {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal == 0) return (0, 0);
        toRewards = (bal * rewardsBps) / BPS;
        toTreasury = bal - toRewards;
        if (toRewards > 0) _send(rewards, toRewards);
        if (toTreasury > 0) _send(treasury, toTreasury);
        emit Distributed(toTreasury, toRewards);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    /// @notice Swap the rewards wallet, e.g. if its key is ever at risk.
    function setRewards(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        rewards = r;
        emit RewardsSet(r);
    }

    function setRewardsBps(uint16 bps) external onlyOwner {
        if (bps > MAX_REWARDS_BPS) revert ShareTooHigh();
        rewardsBps = bps;
        emit RewardsBpsSet(bps);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _send(address to, uint256 amount) private {
        usdc.safeTransfer(to, amount);
    }
}
