// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
 * @notice Mainnet dollar route: moves a losing chain's money to the winning chain's
 * migrator with Across (Base, BNB Chain, Robinhood Chain and Arc dollars, ~2 s fills).
 * One per chain.
 *
 * Sending side: only the consolidator may send. The money goes to this bridge's twin on the
 * winning chain (fixed per route at setup), tagged with the coin. Across takes its fee out of
 * the money (no native token needed): the deposit asks for `amount * (1 - feeBps)` on arrival,
 * and feeBps can never exceed MAX_FEE_BPS (0.5%).
 *
 * Dollars differ in decimals between chains (USDC on BNB Chain has 18, on Base and Arc 6, USDG
 * on Robinhood Chain 6): each route knows its token's decimals and the amount asked for on
 * arrival is converted to them. Across fills a deposit only when the output amount is right.
 *
 * Receiving side: Across's SpokePool pays the twin and calls `handleV3AcrossMessage`; the
 * money is passed to the local migrator for that coin. Anyone could send money here through
 * Across, but it can only ever end up in a coin's locked pool (a gift), never anywhere else.
 *
 * If a deposit is never filled (fee too low for relayers), Across refunds it to this contract
 * after the fill window; the owner (sasa's Safe) can then send it again, to the same coin and
 * the same chain only, with a new fee within the cap.
 *
 * Two-step routes: where Across has no dollar route between two chains (BNB Chain and Robinhood
 * Chain), the route goes through a third chain (Base). The money goes to the bridge there with
 * the final chain in the message; that bridge holds it as a "hop" (Across can't start a new
 * deposit while it is filling one) until anyone calls `forwardHop`, which sends it on to the
 * final chain's bridge. The caller gets a small tip out of the money for the gas (at most
 * 5 cents and at most 1%), so nobody has to pay that gas out of pocket. A hop can only go to
 * the coin on the chain written in it, never anywhere else.
 */
contract AcrossUsdBridge is IUsdcBridge, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        uint256 chainId; // EVM chain id of the destination
        address outputToken; // its dollar (USDC / USDG)
        address twin; // the AcrossUsdBridge there
        uint8 outputDecimals; // decimals of outputToken
        bool viaHop; // true: chainId / outputToken / twin are the middle chain's; the money goes on from there
    }

    struct Hop {
        bytes32 coin;
        uint32 finalEid;
        bool buyback;
        bool forwarded;
        uint256 amount;
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
    /// @notice Most a `forwardHop` caller gets for the gas: 1% of the hop, and never above 5 cents.
    uint256 public constant TIP_BPS = 100;
    uint256 public constant MAX_TIP_CENTS = 5;

    IAcrossSpokePool public immutable spokePool;
    IERC20 public immutable token;
    /// @notice Decimals of `token` (this chain's dollar).
    uint8 public immutable tokenDecimals;

    address public consolidator;
    address public migrator;
    uint256 public feeBps = 10; // 0.1% to start: Across's USDC fees are well below this
    bool public locked;
    mapping(uint32 eid => Route) public routes;
    uint32[] internal _eidsSet;
    Sent[] public sends;
    Hop[] public hops;
    /// @notice Money held here for hops not forwarded yet: never usable by `resend`.
    uint256 public waitingForHops;

    event Sent_(uint256 indexed id, uint32 indexed dstEid, bytes32 indexed coin, uint256 amount, uint256 outputAmount, bool buyback);
    event Delivered(bytes32 indexed coin, uint256 amount, bool buyback, address relayer);
    event FeeSet(uint256 feeBps);
    event HopWaiting(uint256 indexed hopId, bytes32 indexed coin, uint32 indexed finalEid, uint256 amount, bool buyback);
    event HopForwarded(uint256 indexed hopId, uint256 indexed sendId, address indexed caller, uint256 tip);

    error NotConsolidator();
    error NotSpokePool();
    error WrongToken();
    error UnknownRoute();
    error Locked();
    error BadAddress();
    error FeeTooHigh();
    error AlreadyResent();
    error NotRefunded();
    error AlreadyForwarded();

    constructor(IAcrossSpokePool spokePool_, IERC20 token_, address owner_) Ownable(owner_) {
        if (address(spokePool_) == address(0) || address(token_) == address(0)) revert BadAddress();
        spokePool = spokePool_;
        token = token_;
        tokenDecimals = IERC20Metadata(address(token_)).decimals();
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
        _eidsSet = eids;
        for (uint256 i; i < eids.length; ++i) {
            Route calldata r = routes_[i];
            if (r.chainId == 0 || r.outputToken == address(0) || r.twin == address(0)) revert BadAddress();
            if (r.outputDecimals == 0 || r.outputDecimals > 36) revert BadAddress();
            routes[eids[i]] = r;
        }
        // a two-step route's middle chain must itself be a direct route of this bridge
        for (uint256 i; i < eids.length; ++i) {
            if (routes_[i].viaHop && !_isDirectTo(routes_[i].chainId, routes_[i].twin)) revert UnknownRoute();
        }
    }

    function _isDirectTo(uint256 chainId, address twin) internal view returns (bool) {
        for (uint256 i; i < _eidsSet.length; ++i) {
            Route storage d = routes[_eidsSet[i]];
            if (!d.viaHop && d.chainId == chainId && d.twin == twin) return true;
        }
        return false;
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
        _resend(id, sends[id].amount, newFeeBps);
    }

    /**
     * @notice Same as `resend`, for a refund smaller than the deposit (if Across ever
     * refunds less): sends `amount` (at most the original, at most what this bridge holds)
     * to the same coin and destination.
     */
    function resendAmount(uint256 id, uint256 amount, uint256 newFeeBps) external onlyOwner nonReentrant {
        _resend(id, amount, newFeeBps);
    }

    function _resend(uint256 id, uint256 amount, uint256 newFeeBps) internal {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        Sent storage s = sends[id];
        if (s.resent) revert AlreadyResent();
        // only refunded money can go again, never money waiting for a hop
        if (amount == 0 || amount > s.amount || token.balanceOf(address(this)) < amount + waitingForHops) revert NotRefunded();
        s.resent = true;
        uint256 nid = sends.length;
        sends.push(Sent(s.dstEid, s.buyback, false, s.coin, amount));
        _deposit(nid, s.dstEid, s.coin, amount, s.buyback, newFeeBps);
    }

    function _deposit(uint256 id, uint32 dstEid, bytes32 coin, uint256 amount, bool buyback, uint256 bps) internal {
        Route memory r = routes[dstEid];
        if (r.twin == address(0)) revert UnknownRoute();
        // the fee comes off in this chain's units, then the rest is expressed in the destination's
        uint256 out = convertDecimals((amount * (10_000 - bps)) / 10_000, tokenDecimals, r.outputDecimals);
        // Less than one unit of the destination's dollar (under $0.000001): nothing to ask for.
        // It stays here as dust instead of blocking the rest of the move.
        if (out == 0) {
            emit Sent_(id, dstEid, coin, amount, 0, buyback);
            return;
        }
        token.forceApprove(address(spokePool), amount);
        spokePool.depositV3Now(
            address(this),
            r.twin,
            address(token),
            r.outputToken,
            amount,
            out,
            r.chainId,
            address(0),
            FILL_WINDOW,
            0,
            abi.encode(coin, buyback, r.viaHop ? dstEid : uint32(0))
        );
        token.forceApprove(address(spokePool), 0);
        emit Sent_(id, dstEid, coin, amount, out, buyback);
    }

    /// @notice `amount` with `from` decimals expressed with `to` decimals (rounded down).
    function convertDecimals(uint256 amount, uint8 from, uint8 to) public pure returns (uint256) {
        if (from == to) return amount;
        if (from > to) return amount / (10 ** (from - to));
        return amount * (10 ** (to - from));
    }

    function sendsCount() external view returns (uint256) {
        return sends.length;
    }

    function hopsCount() external view returns (uint256) {
        return hops.length;
    }

    // ------------------------------------------------------------ two-step routes

    /// @notice What `forwardHop` would pay its caller for hop `amount` (in this chain's dollar).
    function tipFor(uint256 amount) public view returns (uint256) {
        uint256 cap = (MAX_TIP_CENTS * 10 ** tokenDecimals) / 100;
        uint256 t = (amount * TIP_BPS) / 10_000;
        return t < cap ? t : cap;
    }

    /**
     * @notice Sends a waiting hop on to its final chain. Anyone may call it (sasa's keeper does,
     * right after the money lands); the caller gets `tipFor(amount)` for the gas, the rest goes
     * to the coin on the final chain. Once per hop.
     */
    function forwardHop(uint256 hopId) external nonReentrant {
        Hop storage h = hops[hopId];
        if (h.forwarded) revert AlreadyForwarded();
        h.forwarded = true;
        waitingForHops -= h.amount;
        uint256 tip = tipFor(h.amount);
        uint256 rest = h.amount - tip;
        uint256 sid = sends.length;
        sends.push(Sent(h.finalEid, h.buyback, false, h.coin, rest));
        if (tip > 0) token.safeTransfer(msg.sender, tip);
        _deposit(sid, h.finalEid, h.coin, rest, h.buyback, feeBps);
        emit HopForwarded(hopId, sid, msg.sender, tip);
    }

    // ------------------------------------------------------------ receive

    /// @notice Across's SpokePool calls this after paying `amount` of `tokenSent` here.
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes memory message)
        external
        nonReentrant
    {
        if (msg.sender != address(spokePool)) revert NotSpokePool();
        if (tokenSent != address(token)) revert WrongToken();
        (bytes32 coin, bool buyback, uint32 finalEid) = abi.decode(message, (bytes32, bool, uint32));
        if (finalEid != 0) {
            // first half of a two-step route: hold it until `forwardHop`. The final chain must
            // be a direct route from here, else Across doesn't fill and refunds the sender.
            Route storage f = routes[finalEid];
            if (f.twin == address(0) || f.viaHop) revert UnknownRoute();
            uint256 hid = hops.length;
            hops.push(Hop(coin, finalEid, buyback, false, amount));
            waitingForHops += amount;
            emit HopWaiting(hid, coin, finalEid, amount, buyback);
            return;
        }
        token.safeTransfer(migrator, amount);
        IMigratorReceiveAcross(migrator).receiveConsolidated(coin, amount, buyback);
        emit Delivered(coin, amount, buyback, relayer);
    }
}
