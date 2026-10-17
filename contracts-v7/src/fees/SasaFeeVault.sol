// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// the race builders keep a payment they couldn't make (heldFor) until its owner claims it
interface IHeldPayments {
    function claimHeld() external;
}

/**
 * @title SasaFeeVault
 * @notice sasa's treasury address on one chain. Every fee the race contracts pay sasa lands here
 * (the chain's coin and its dollar), and anyone can split it, at any time, into fixed shares:
 *
 *   10% to the keeper   (pays the network fees of running the races, so it never runs dry)
 *   10% to rewards      (pays invite rewards)
 *   80% to the treasury (sasa's own wallet)
 *
 * Anything else that lands here (the race coins' own fee shares, the coin-move fee) belongs to the
 * treasury in full: `sweep` sends it there.
 *
 * It never holds funds for long and has no other powers. The shares and the treasury never change.
 * The owner (the treasury) may only point the keeper or rewards share at a new wallet, e.g. after
 * replacing a key; never at nobody.
 *
 * Receiving the chain's coin does nothing but keep it (the race contracts send it with a small gas
 * allowance), so a payment here can never fail.
 */
contract SasaFeeVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant KEEPER_BPS = 1_000; // 10%
    uint256 public constant REWARDS_BPS = 1_000; // 10%
    uint256 internal constant BPS = 10_000;

    address public immutable treasury;
    /// @notice The chain's dollar (USDC): split like the chain's coin.
    IERC20 public immutable dollar;
    address public keeper;
    address public rewards;

    event Split(address indexed token, uint256 toKeeper, uint256 toRewards, uint256 toTreasury);
    event Swept(address indexed token, uint256 amount);
    event KeeperSet(address keeper);
    event RewardsSet(address rewards);

    error ZeroAddress();
    error NotSwept();
    error SendFailed();
    error RenounceDisabled();

    constructor(address keeper_, address rewards_, address treasury_, IERC20 dollar_) Ownable(treasury_) {
        if (keeper_ == address(0) || rewards_ == address(0) || treasury_ == address(0) || address(dollar_) == address(0)) {
            revert ZeroAddress();
        }
        keeper = keeper_;
        rewards = rewards_;
        treasury = treasury_;
        dollar = dollar_;
    }

    receive() external payable {}

    /// @notice Splits everything held of the chain's coin and of the dollar. Anyone may call it.
    function distribute() external nonReentrant {
        uint256 n = address(this).balance;
        if (n > 0) {
            (uint256 k, uint256 r, uint256 t) = _shares(n);
            // a keeper or rewards wallet that refuses the coin forfeits that share to the treasury
            if (k > 0 && !_send(keeper, k)) t += k;
            if (r > 0 && !_send(rewards, r)) t += r;
            if (!_send(treasury, t)) revert SendFailed();
            emit Split(address(0), k, r, t);
        }
        uint256 d = dollar.balanceOf(address(this));
        if (d > 0) {
            (uint256 k, uint256 r, uint256 t) = _shares(d);
            // a keeper or rewards wallet the dollar won't pay (e.g. blocklisted) forfeits its
            // share to the treasury instead of holding up the whole split
            if (k > 0 && !_tryDollar(keeper, k)) t += k;
            if (r > 0 && !_tryDollar(rewards, r)) t += r;
            dollar.safeTransfer(treasury, t);
            emit Split(address(dollar), k, r, t);
        }
    }

    /// @notice Collects a payment a race builder had to hold for this vault (it couldn't send it
    /// at the time); split it afterwards with distribute(). Anyone may call it.
    function claimHeld(IHeldPayments builder) external nonReentrant {
        builder.claimHeld();
    }

    /// @notice Sends all of any other token held here (race coins) to the treasury. Anyone may call it.
    function sweep(IERC20 token) external nonReentrant {
        if (address(token) == address(dollar)) revert NotSwept();
        uint256 a = token.balanceOf(address(this));
        if (a > 0) {
            token.safeTransfer(treasury, a);
            emit Swept(address(token), a);
        }
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setRewards(address rewards_) external onlyOwner {
        if (rewards_ == address(0)) revert ZeroAddress();
        rewards = rewards_;
        emit RewardsSet(rewards_);
    }

    /// @notice The owner can never leave: the keeper / rewards wallets must stay replaceable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _shares(uint256 a) internal pure returns (uint256 k, uint256 r, uint256 t) {
        k = (a * KEEPER_BPS) / BPS;
        r = (a * REWARDS_BPS) / BPS;
        t = a - k - r;
    }

    function _tryDollar(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = address(dollar).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _send(address to, uint256 amount) internal returns (bool ok) {
        (ok,) = to.call{value: amount}("");
    }
}
