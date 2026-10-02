// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUsdcBridge} from "./ConsolidatorV6.sol";

/// @notice The parts of Across's SpokePool this adapter uses.
interface IAcrossSpokePool {
    function depositV3Now(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 fillDeadlineOffset,
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable;
}

interface IMigratorReceiveAcross {
    function receiveConsolidated(bytes32 coin, uint256 amount, bool buyback) external;
}

/**
 * @title AcrossUsdBridge
 * @notice Mainnet dollar route for v6: moves a losing chain's money to the winning chain's
 * migrator with Across (Base USDC <-> Robinhood USDG, converted by Across, ~2 s fills).
 * One per chain.
 *
 * Sending side: only the consolidator may send. The money goes to this bridge's twin on the
 * winning chain (fixed per route at setup), tagged with the coin. Across takes its fee out of
 * the money (no native token needed): the deposit asks for `amount * (1 - feeBps)` on arrival,
 * and feeBps can never exceed MAX_FEE_BPS (0.5%).
 *
 * Receiving side: Across's SpokePool pays the twin and calls `handleV3AcrossMessage`; the
 * money is passed to the local migrator for that coin. Anyone could send money here through
 * Across, but it can only ever end up in a coin's locked pool (a gift), never anywhere else.
 *
 * If a deposit is never filled (fee too low for relayers), Across refunds it to this contract
 * after the fill window; the owner (sasa's Safe) can then send it again, to the same coin and
 * the same chain only, with a new fee within the cap.
 */
contract AcrossUsdBridge is IUsdcBridge, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        uint256 chainId; // EVM chain id of the destination
        address outputToken; // its dollar (USDC / USDG)
        address twin; // the AcrossUsdBridge there
    }

    struct Sent {
        uint32 dstEid;
        bool buyback;
        bool resent;
        bytes32 coin;
        uint256 amount;
    }

    uint256 public constant MAX_FEE_BPS = 50;
    uint32 public constant FILL_WINDOW = 4 hours;

    IAcrossSpokePool public immutable spokePool;
    IERC20 public immutable token;

    address public consolidator;
    address public migrator;
    uint256 public feeBps = 10; // 0.1% to start: Across's USDC fees are well below this
    bool public locked;
    mapping(uint32 eid => Route) public routes;
    Sent[] public sends;

    event Sent_(uint256 indexed id, uint32 indexed dstEid, bytes32 indexed coin, uint256 amount, uint256 outputAmount, bool buyback);
    event Delivered(bytes32 indexed coin, uint256 amount, bool buyback, address relayer);
    event FeeSet(uint256 feeBps);

    error NotConsolidator();
    error NotSpokePool();
    error WrongToken();
    error UnknownRoute();
    error Locked();
    error BadAddress();
    error FeeTooHigh();
    error AlreadyResent();
    error NotRefunded();

    constructor(IAcrossSpokePool spokePool_, IERC20 token_, address owner_) Ownable(owner_) {
        if (address(spokePool_) == address(0) || address(token_) == address(0)) revert BadAddress();
        spokePool = spokePool_;
        token = token_;
    }

    // ------------------------------------------------------------ setup (once)

    function setup(address consolidator_, address migrator_, uint32[] calldata eids, Route[] calldata routes_)
        external
        onlyOwner
    {
        if (locked) revert Locked();
        if (consolidator_ == address(0) || migrator_ == address(0) || eids.length != routes_.length) revert BadAddress();
        consolidator = consolidator_;
        migrator = migrator_;
        for (uint256 i; i < eids.length; ++i) {
            Route calldata r = routes_[i];
            if (r.chainId == 0 || r.outputToken == address(0) || r.twin == address(0)) revert BadAddress();
            routes[eids[i]] = r;
        }
    }

    /// @notice After this the routes can't change (new chains get a new bridge). The fee stays
    /// adjustable within the cap, so fills keep working when Across's prices move.
    function lock() external onlyOwner {
        locked = true;
    }

    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeSet(bps);
    }

    // ------------------------------------------------------------ send

    /// @notice Across needs no native fee: it is taken out of the money itself.
    function quote(uint32, uint256) external pure returns (uint256) {
        return 0;
    }

    function send(uint32 dstEid, bytes32 coin, uint256 amount, bool buyback, address refund)
        external
        payable
        nonReentrant
    {
        if (msg.sender != consolidator) revert NotConsolidator();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 id = sends.length;
        sends.push(Sent(dstEid, buyback, false, coin, amount));
        _deposit(id, dstEid, coin, amount, buyback, feeBps);
        // Nothing to pay in native coin: hand back anything sent along.
        if (msg.value > 0) {
            (bool ok,) = refund.call{value: msg.value}("");
            ok; // a refusing refund address must not block the money from moving
        }
    }

    /**
     * @notice Sends an unfilled (refunded) deposit again: same coin, same destination, same
     * amount, with a new fee within the cap. Owner only, once per deposit.
     */
    function resend(uint256 id, uint256 newFeeBps) external onlyOwner nonReentrant {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        Sent storage s = sends[id];
        if (s.resent) revert AlreadyResent();
        if (token.balanceOf(address(this)) < s.amount) revert NotRefunded();
        s.resent = true;
        uint256 nid = sends.length;
        sends.push(Sent(s.dstEid, s.buyback, false, s.coin, s.amount));
        _deposit(nid, s.dstEid, s.coin, s.amount, s.buyback, newFeeBps);
    }

    function _deposit(uint256 id, uint32 dstEid, bytes32 coin, uint256 amount, bool buyback, uint256 bps) internal {
        Route memory r = routes[dstEid];
        if (r.twin == address(0)) revert UnknownRoute();
        uint256 out = (amount * (10_000 - bps)) / 10_000;
        token.forceApprove(address(spokePool), amount);
        spokePool.depositV3Now(
            address(this), r.twin, address(token), r.outputToken, amount, out, r.chainId, address(0), FILL_WINDOW, 0, abi.encode(coin, buyback)
        );
        token.forceApprove(address(spokePool), 0);
        emit Sent_(id, dstEid, coin, amount, out, buyback);
    }

    function sendsCount() external view returns (uint256) {
        return sends.length;
    }

    // ------------------------------------------------------------ receive

    /// @notice Across's SpokePool calls this after paying `amount` of `tokenSent` here.
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes memory message)
        external
        nonReentrant
    {
        if (msg.sender != address(spokePool)) revert NotSpokePool();
        if (tokenSent != address(token)) revert WrongToken();
        (bytes32 coin, bool buyback) = abi.decode(message, (bytes32, bool));
        token.safeTransfer(migrator, amount);
        IMigratorReceiveAcross(migrator).receiveConsolidated(coin, amount, buyback);
        emit Delivered(coin, amount, buyback, relayer);
    }
}
