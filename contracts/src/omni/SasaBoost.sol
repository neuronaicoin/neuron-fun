// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SasaBoost
 * @notice Paid placement: anyone pays dollars to show a coin in the "Boosted" row on
 * sasa for a while. The payment goes straight to sasa's treasury; the time adds up
 * (boosting a boosted coin extends it). The site and indexer read `boostedUntil`.
 */
contract SasaBoost is Ownable {
    using SafeERC20 for IERC20;

    struct Plan {
        uint96 price; // dollars, 6 decimals
        uint32 duration; // seconds
    }

    IERC20 public immutable usd;
    address public treasury;
    Plan[] public plans;
    mapping(address coin => uint64) public boostedUntil;

    event Boosted(address indexed coin, address indexed payer, uint256 plan, uint256 paid, uint64 until);
    event PlanSet(uint256 indexed plan, uint96 price, uint32 duration);
    event TreasurySet(address treasury);

    error BadPlan();
    error ZeroAddress();

    constructor(IERC20 usd_, address treasury_, address owner_) Ownable(owner_) {
        if (address(usd_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usd = usd_;
        treasury = treasury_;
        // $10 for 6 hours, $20 for 24 hours.
        plans.push(Plan(10e6, 6 hours));
        plans.push(Plan(20e6, 24 hours));
    }

    function boost(address coin, uint256 plan) external returns (uint64 until) {
        if (plan >= plans.length || coin == address(0)) revert BadPlan();
        Plan memory p = plans[plan];
        if (p.duration == 0) revert BadPlan();
        usd.safeTransferFrom(msg.sender, treasury, p.price);
        uint64 from = boostedUntil[coin] > block.timestamp ? boostedUntil[coin] : uint64(block.timestamp);
        until = from + p.duration;
        boostedUntil[coin] = until;
        emit Boosted(coin, msg.sender, plan, p.price, until);
    }

    function plansCount() external view returns (uint256) {
        return plans.length;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Change or add a plan (index == length adds one; duration 0 retires one).
    function setPlan(uint256 plan, uint96 price, uint32 duration) external onlyOwner {
        if (plan > plans.length) revert BadPlan();
        if (plan == plans.length) plans.push(Plan(price, duration));
        else plans[plan] = Plan(price, duration);
        emit PlanSet(plan, price, duration);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }
}
