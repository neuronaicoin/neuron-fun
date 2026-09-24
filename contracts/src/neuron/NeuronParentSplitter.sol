// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPairPadFeeEscrow} from "../v2/interfaces/ILaunchpadV2.sol";

interface INeuronSwapRouter {
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        payable
        returns (uint256 amountOut);
}

interface INeuronParentRegistry {
    function operator() external view returns (address);
    function routeOf(address parent) external view returns (PoolKey memory);
}

/**
 * @title NeuronParentSplitter
 * @notice The creator fee recipient of one Neuron.fun launch. The launch
 * factory credits the creator's share of trading fees to the fee escrow
 * under this address; this contract splits it between the creator and the
 * launch's Parent:
 *
 * - ETH: `parentShareBps` is set aside for Parent buybacks, the rest is owed
 *   to the creator, who is paid with `payCreator` (anyone may call it; the
 *   money only ever goes to the creator).
 * - Launch tokens (fees on sells arrive in the token): the Parent's share is
 *   burned, the rest is sent to the creator.
 * - `buybackParent` spends set-aside ETH buying the Parent through its
 *   registered route and sends what it buys straight to the dead address.
 *   Only the registry's operator may call it, because it carries the
 *   slippage floor; the operator can delay a buyback, not redirect it.
 *
 * There is no owner and no function that sends value anywhere else. The
 * factory only lets the current recipient hand the role on, and this
 * contract has no function that does, so the split lasts for the life of
 * the token (subject to the factory owner's published, time-locked
 * recovery path for fee recipients).
 */
contract NeuronParentSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPairPadFeeEscrow public immutable escrow;
    INeuronSwapRouter public immutable router;
    INeuronParentRegistry public immutable registry;
    address public immutable launcher;
    address public immutable parent;
    uint16 public immutable parentShareBps;

    address public child;
    address public creator;
    address public pendingCreator;

    /// @notice ETH owed to the creator, not yet paid.
    uint256 public creatorEth;
    /// @notice ETH set aside for Parent buybacks, not yet spent.
    uint256 public parentEth;

    uint256 public totalCreatorEthPaid;
    uint256 public totalParentEthSpent;
    uint256 public totalParentBurned;
    uint256 public totalChildBurned;
    uint256 public totalChildToCreator;

    event ChildBound(address indexed child, address indexed parent, address indexed creator, uint16 parentShareBps);
    event Split(uint256 ethIn, uint256 toParent, uint256 toCreator);
    event ChildTokensSplit(uint256 amountIn, uint256 burned, uint256 toCreator);
    event CreatorPaid(address indexed creator, uint256 amount);
    event ParentBoughtBack(address indexed parent, uint256 ethIn, uint256 parentBurned);
    event CreatorTransferStarted(address indexed creator, address indexed pendingCreator);
    event CreatorTransferred(address indexed previousCreator, address indexed newCreator);

    error ZeroAddress();
    error InvalidBps();
    error NotLauncher();
    error AlreadyBound();
    error NotBound();
    error NotOperator();
    error NotCreator();
    error NotPendingCreator();
    error ZeroAmount();
    error InsufficientParentEth(uint256 requested, uint256 available);
    error TransferFailed();

    constructor(
        IPairPadFeeEscrow escrow_,
        INeuronSwapRouter router_,
        INeuronParentRegistry registry_,
        address parent_,
        address creator_,
        uint16 parentShareBps_
    ) {
        if (
            address(escrow_) == address(0) || address(router_) == address(0) || address(registry_) == address(0)
                || parent_ == address(0) || creator_ == address(0)
        ) revert ZeroAddress();
        if (parentShareBps_ > BPS) revert InvalidBps();
        escrow = escrow_;
        router = router_;
        registry = registry_;
        launcher = msg.sender;
        parent = parent_;
        creator = creator_;
        parentShareBps = parentShareBps_;
    }

    /// @dev The escrow pays claimed ETH here. ETH sent by anyone else is
    /// split like fees on the next `sync`.
    receive() external payable {}

    /// @notice Called once by the launcher, in the launch transaction, when
    /// the launch token's address is known.
    function bindChild(address child_) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (child != address(0)) revert AlreadyBound();
        if (child_ == address(0)) revert ZeroAddress();
        child = child_;
        emit ChildBound(child_, parent, creator, parentShareBps);
    }

    /**
     * @notice Claims everything the escrow holds for this address and
     * splits it. Anyone may call.
     */
    function sync() public nonReentrant {
        _sync();
    }

    /// @notice Syncs, then pays the creator everything owed. Anyone may call.
    function payCreator() external nonReentrant returns (uint256 amount) {
        _sync();
        amount = creatorEth;
        if (amount == 0) return 0;
        creatorEth = 0;
        totalCreatorEthPaid += amount;
        address to = creator;
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit CreatorPaid(to, amount);
    }

    /**
     * @notice Spends `amountIn` of the set-aside ETH buying the Parent and
     * burns it by sending it to the dead address.
     * @param minParentOut Slippage floor; the swap reverts below it.
     */
    function buybackParent(uint256 amountIn, uint256 minParentOut)
        external
        nonReentrant
        returns (uint256 parentOut)
    {
        if (msg.sender != registry.operator()) revert NotOperator();
        _sync();
        if (amountIn == 0) revert ZeroAmount();
        uint256 available = parentEth;
        if (amountIn > available) revert InsufficientParentEth(amountIn, available);

        PoolKey memory route = registry.routeOf(parent);
        parentEth = available - amountIn;
        // The route is native ETH (currency0) to the Parent (currency1).
        parentOut = router.swapExactIn{value: amountIn}(route, true, amountIn, minParentOut, DEAD);

        totalParentEthSpent += amountIn;
        totalParentBurned += parentOut;
        emit ParentBoughtBack(parent, amountIn, parentOut);
    }

    /// @notice First step of handing the creator role to `newCreator`.
    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    /// @notice Second step: the new creator accepts. ETH already owed moves
    /// with the role.
    function acceptCreator() external {
        if (msg.sender != pendingCreator) revert NotPendingCreator();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }

    /// @notice ETH the escrow holds for this address, not yet claimed.
    function pendingInEscrow() external view returns (uint256 eth, uint256 childTokens) {
        eth = escrow.balanceOf(address(this));
        if (child != address(0)) childTokens = escrow.balanceOfToken(address(this), child);
    }

    function _sync() private {
        address child_ = child;
        if (child_ == address(0)) revert NotBound();

        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        // Everything above what is already accounted for is new income:
        // escrow claims and any ETH sent here directly.
        uint256 accounted = creatorEth + parentEth;
        uint256 balance = address(this).balance;
        if (balance > accounted) {
            uint256 ethIn = balance - accounted;
            uint256 toParent = ethIn * parentShareBps / BPS;
            uint256 toCreator = ethIn - toParent;
            parentEth += toParent;
            creatorEth += toCreator;
            emit Split(ethIn, toParent, toCreator);
        }

        if (escrow.balanceOfToken(address(this), child_) > 0) escrow.claimToken(child_);
        uint256 tokens = IERC20(child_).balanceOf(address(this));
        if (tokens > 0) {
            uint256 toBurn = tokens * parentShareBps / BPS;
            uint256 toCreator = tokens - toBurn;
            if (toBurn > 0) ERC20Burnable(child_).burn(toBurn);
            if (toCreator > 0) IERC20(child_).safeTransfer(creator, toCreator);
            totalChildBurned += toBurn;
            totalChildToCreator += toCreator;
            emit ChildTokensSplit(tokens, toBurn, toCreator);
        }
    }
}
