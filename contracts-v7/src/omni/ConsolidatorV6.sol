// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IHubLocal {
    function localOf(bytes32 coin) external view returns (address curve, uint256 target, uint64 round, uint32[] memory eids);
}

interface ICurveWinner {
    function winnerEid() external view returns (uint32);
}

/**
 * @notice Moves USDC to the winning chain's migrator, tagged with its coin.
 * One adapter per USDC route (CCTP, Stargate...) implements it; on arrival it calls
 * `MigratorV6.receiveConsolidated(coin, amount, buyback)` on the winning chain.
 * The adapter takes the USDC with `transferFrom` from the caller.
 */
interface IUsdcBridge {
    function quote(uint32 dstEid, uint256 amount) external view returns (uint256 nativeFee);
    function send(uint32 dstEid, bytes32 coin, uint256 amount, bool buyback, address refund) external payable;
}

/**
 * @title ConsolidatorV6
 * @notice On a chain that lost a coin's race, collects that coin's money from its
 * curve (and its buyback share) and sends it to the winning chain, where the
 * migrator adds it to the coin's locked pool (or buys back with it).
 *
 * It cannot send money anywhere else: the destination is the winner named in the
 * coin's own curve, and the route is the bridge adapter fixed at deployment.
 * Anyone may call `forward` (sasa's keeper does, right after graduation).
 */
contract ConsolidatorV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IHubLocal public immutable hub;
    IUsdcBridge public immutable bridge;

    /// @notice USDC waiting to be sent, per coin (pool money / buyback money).
    mapping(bytes32 coin => uint256) public pendingPool;
    mapping(bytes32 coin => uint256) public pendingBuyback;
    uint256 private _held;

    event Received(bytes32 indexed coin, uint256 amount, bool buyback);
    event Forwarded(bytes32 indexed coin, uint32 dstEid, uint256 amount, bool buyback);

    error NotTheCurve();
    error NothingToSend();
    error NotDelivered();

    constructor(IERC20 usdc_, IHubLocal hub_, IUsdcBridge bridge_) {
        usdc = usdc_;
        hub = hub_;
        bridge = bridge_;
    }

    function _curveOf(bytes32 coin) internal view returns (address curve) {
        (curve,,,) = hub.localOf(coin);
        if (curve == address(0) || curve != msg.sender) revert NotTheCurve();
    }

    /// @notice A losing curve hands over its money (already transferred).
    function fromCurve(bytes32 coin, uint256 money) external nonReentrant {
        _curveOf(coin);
        if (usdc.balanceOf(address(this)) < _held + money) revert NotDelivered();
        pendingPool[coin] += money;
        _held += money;
        emit Received(coin, money, false);
    }

    /// @notice A losing curve's buyback share (pulled from the curve).
    function depositBuyback(bytes32 coin, uint256 amount) external nonReentrant {
        _curveOf(coin);
        if (amount == 0) return;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        pendingBuyback[coin] += amount;
        _held += amount;
        emit Received(coin, amount, true);
    }

    /// @notice Sends what is waiting for `coin` to its winning chain. `msg.value` pays the route.
    function forward(bytes32 coin) external payable nonReentrant {
        (address curve,,,) = hub.localOf(coin);
        uint32 dst = ICurveWinner(curve).winnerEid();
        if (dst == 0) revert NothingToSend();
        uint256 pool = pendingPool[coin];
        uint256 bb = pendingBuyback[coin];
        if (pool + bb == 0) revert NothingToSend();
        pendingPool[coin] = 0;
        pendingBuyback[coin] = 0;
        _held -= pool + bb;
        usdc.forceApprove(address(bridge), pool + bb);
        uint256 feePool = pool > 0 && bb > 0 ? msg.value / 2 : msg.value;
        if (pool > 0) {
            bridge.send{value: feePool}(dst, coin, pool, false, msg.sender);
            emit Forwarded(coin, dst, pool, false);
        }
        if (bb > 0) {
            bridge.send{value: msg.value - (pool > 0 ? feePool : 0)}(dst, coin, bb, true, msg.sender);
            emit Forwarded(coin, dst, bb, true);
        }
        usdc.forceApprove(address(bridge), 0);
    }
}
