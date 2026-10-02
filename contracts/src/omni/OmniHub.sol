// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OApp, Origin, MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

interface ICurveV6Hub {
    function freeze() external returns (uint256 money, uint256 coinsSold);
    function reopen() external;
    function settle(uint32 winner, bool isWinner, uint256 poolTokens, uint256 total) external;
    function initialVirtualNative() external view returns (uint256);
    function initialVirtualToken() external view returns (uint256);
}

/**
 * @title OmniHub (v6)
 * @notice One per chain. Links each omnichain coin's curve on this chain to the
 * coordinator, over LayerZero. The hub on the coordinator chain is also the coordinator.
 *
 * Graduation, step by step:
 *  1. Once the total across chains passes the target, the keeper calls `freeze(coin)`
 *     on every chain the coin trades on. The curve stops and this hub reports its
 *     money and coins sold to the coordinator.
 *  2. When every chain of the coin has reported (same round), anyone calls
 *     `finalize(coin)` on the coordinator. It adds the reports up ON-CHAIN:
 *       - total below the target: every chain reopens (a wrong freeze harms nobody);
 *       - otherwise the chain with the most money wins, and the pool size follows from
 *         the total raised R: poolTokens = R / P_g, P_g = (V0 + R)^2 / (V0 * T0).
 *  3. Each hub receives the verdict and settles its curve (money to the migrator on the
 *     winner, to the consolidator elsewhere; the coin's bridge opens).
 *
 * The keeper cannot pick the winner or move money. If the keeper stops, anyone may
 * freeze a coin after 10 minutes without a keeper heartbeat (once per hour per coin,
 * so freezes cannot be spammed).
 *
 * Admin (the owner, sasa's Safe): registers the factory, names the keeper and links
 * hubs on new chains (peers). It cannot touch curves, money or coins.
 */
contract OmniHub is OApp {
    uint8 internal constant KIND_REPORT = 1;
    uint8 internal constant KIND_VERDICT = 2;
    uint8 internal constant KIND_REOPEN = 3;

    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant KEEPER_GRACE = 10 minutes;
    uint256 public constant PUBLIC_FREEZE_GAP = 1 hours;
    uint256 public constant MAX_CHAINS = 8;

    /// @notice LayerZero endpoint id of the coordinator chain.
    uint32 public immutable coordEid;
    /// @notice This chain's endpoint id.
    uint32 public immutable localEid;

    address public factory;
    address public keeper;
    uint256 public lastKeeperPing;

    struct Local {
        address curve;
        uint256 target;
        uint64 round; // reopens received so far
        uint64 lastPublicFreeze;
        uint32[] eids; // every chain the coin launched on
    }

    struct Report {
        bool seen;
        uint256 money;
        uint256 sold;
    }

    struct Tally {
        uint64 round;
        uint8 count;
        bool done;
        bytes32 setHash;
        uint256 v; // per-chain virtual start (same on all chains)
        uint256 t;
        uint256 target;
        uint32[] eids;
    }

    mapping(bytes32 coin => Local) internal locals;
    // coordinator side
    mapping(bytes32 coin => Tally) internal tallies;
    mapping(bytes32 coin => mapping(uint64 round => mapping(uint32 eid => Report))) public reports;

    event Registered(bytes32 indexed coin, address curve, uint32[] eids, uint256 target);
    event FreezeSent(bytes32 indexed coin, uint64 round, uint256 money, uint256 sold);
    event ReportIn(bytes32 indexed coin, uint64 round, uint32 eid, uint256 money, uint256 sold);
    event Decided(bytes32 indexed coin, uint64 round, bool graduate, uint32 winner, uint256 total, uint256 poolTokens);
    event Settled(bytes32 indexed coin, uint32 winner, bool isWinner);
    event Reopened(bytes32 indexed coin, uint64 round);

    error NotFactory();
    error NotAllowed();
    error Unknown();
    error BadChains();
    error NotReady();
    error AlreadyDone();
    error Mismatch();

    constructor(address endpoint_, address owner_, uint32 coordEid_, uint32 localEid_)
        OApp(endpoint_, owner_)
        Ownable(owner_)
    {
        coordEid = coordEid_;
        localEid = localEid_;
    }

    // ------------------------------------------------------------------ admin

    event FactorySet(address factory);
    event KeeperSet(address keeper);

    function setFactory(address f) external onlyOwner {
        factory = f;
        emit FactorySet(f);
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        lastKeeperPing = block.timestamp;
        emit KeeperSet(k);
    }

    function ping() external {
        if (msg.sender != keeper) revert NotAllowed();
        lastKeeperPing = block.timestamp;
    }

    // ------------------------------------------------------------------ launch

    /// @notice Called by the factory when a coin's curve is created on this chain.
    function register(bytes32 coin, address curve, uint32[] calldata eids, uint256 target) external {
        if (msg.sender != factory) revert NotFactory();
        if (locals[coin].curve != address(0)) revert NotAllowed();
        if (eids.length == 0 || eids.length > MAX_CHAINS || target == 0) revert BadChains();
        bool here;
        for (uint256 i; i < eids.length; ++i) {
            if (i > 0 && eids[i] <= eids[i - 1]) revert BadChains(); // sorted, no repeats
            if (eids[i] == localEid) here = true;
        }
        if (!here) revert BadChains();
        Local storage l = locals[coin];
        l.curve = curve;
        l.target = target;
        l.eids = eids;
        emit Registered(coin, curve, eids, target);
    }

    function localOf(bytes32 coin) external view returns (address curve, uint256 target, uint64 round, uint32[] memory eids) {
        Local storage l = locals[coin];
        return (l.curve, l.target, l.round, l.eids);
    }

    function tallyOf(bytes32 coin)
        external
        view
        returns (uint64 round, uint8 count, bool done, uint32[] memory eids)
    {
        Tally storage t = tallies[coin];
        return (t.round, t.count, t.done, t.eids);
    }

    // ------------------------------------------------------------------ step 1: freeze + report

    /// @notice Freezes the coin's curve here and reports to the coordinator.
    /// `msg.value` pays the LayerZero fee (nothing on the coordinator chain itself).
    function freeze(bytes32 coin, bytes calldata options) external payable {
        Local storage l = locals[coin];
        if (l.curve == address(0)) revert Unknown();
        if (msg.sender == keeper) {
            lastKeeperPing = block.timestamp;
        } else {
            if (block.timestamp < lastKeeperPing + KEEPER_GRACE) revert NotAllowed();
            if (l.lastPublicFreeze != 0 && block.timestamp < uint256(l.lastPublicFreeze) + PUBLIC_FREEZE_GAP) revert NotAllowed();
            l.lastPublicFreeze = uint64(block.timestamp);
        }
        (uint256 money, uint256 sold) = ICurveV6Hub(l.curve).freeze();
        emit FreezeSent(coin, l.round, money, sold);
        // A coin on this chain only: nothing to ask anyone. Decide here and now, in the
        // same transaction, so it graduates with no pause (and no LayerZero fee).
        if (l.eids.length == 1) {
            _decideAlone(coin, l, money, sold);
            if (msg.value > 0) {
                (bool ok,) = payable(msg.sender).call{value: msg.value}("");
                ok;
            }
            return;
        }
        bytes memory msg_ = abi.encode(
            KIND_REPORT,
            coin,
            l.round,
            localEid,
            money,
            sold,
            l.eids,
            ICurveV6Hub(l.curve).initialVirtualNative(),
            ICurveV6Hub(l.curve).initialVirtualToken(),
            l.target
        );
        if (localEid == coordEid) _onReport(msg_, localEid);
        else _lzSend(coordEid, msg_, options, MessagingFee(msg.value, 0), payable(msg.sender));
    }

    /// @dev The same maths as `preview`, for one chain: graduates at the target, the
    /// winner is this chain, the pool gets R / P_g tokens.
    function _decideAlone(bytes32 coin, Local storage l, uint256 money, uint256 sold) internal {
        uint64 round = l.round;
        if (money < l.target || money == 0) {
            l.round = round + 1;
            ICurveV6Hub(l.curve).reopen();
            emit Decided(coin, round, false, 0, money, 0);
            emit Reopened(coin, round);
            return;
        }
        uint256 v0 = ICurveV6Hub(l.curve).initialVirtualNative();
        uint256 t0 = ICurveV6Hub(l.curve).initialVirtualToken();
        uint256 poolTokens = (money * t0 / (v0 + money)) * v0 / (v0 + money);
        if (sold + poolTokens > MAX_SUPPLY) poolTokens = MAX_SUPPLY - sold;
        emit Decided(coin, round, true, localEid, money, poolTokens);
        ICurveV6Hub(l.curve).settle(localEid, true, poolTokens, money);
        emit Settled(coin, localEid, true);
    }

    // ------------------------------------------------------------------ step 2: decide (coordinator)

    /// @dev Stale or inconsistent reports are ignored (never reverted), so a LayerZero
    /// message can never get stuck on them.
    function _onReport(bytes memory m, uint32 fromEid) internal {
        (, bytes32 coin, uint64 round, uint32 eid, uint256 money, uint256 sold, uint32[] memory eids, uint256 v, uint256 t, uint256 target) =
            abi.decode(m, (uint8, bytes32, uint64, uint32, uint256, uint256, uint32[], uint256, uint256, uint256));
        if (eid != fromEid) return; // a hub only speaks for its own chain
        Tally storage tl = tallies[coin];
        if (tl.done) return;
        bytes32 h = keccak256(abi.encode(eids, v, t, target));
        if (tl.setHash == bytes32(0)) {
            tl.setHash = h;
            tl.v = v;
            tl.t = t;
            tl.target = target;
            tl.eids = eids;
        } else if (tl.setHash != h) {
            return; // launched with different settings on another chain: never counts
        }
        if (round != tl.round) return; // from an older round
        Report storage r = reports[coin][round][eid];
        if (r.seen) return;
        bool member;
        for (uint256 i; i < eids.length; ++i) if (eids[i] == eid) member = true;
        if (!member) return;
        r.seen = true;
        r.money = money;
        r.sold = sold;
        tl.count += 1;
        emit ReportIn(coin, round, eid, money, sold);
    }

    /// @notice The result if `finalize` ran now. Pure maths on the reports.
    function preview(bytes32 coin) public view returns (bool ready, bool graduate, uint32 winner, uint256 total, uint256 poolTokens) {
        Tally storage tl = tallies[coin];
        if (tl.setHash == bytes32(0) || tl.done || tl.count != tl.eids.length) return (false, false, 0, 0, 0);
        uint256 best;
        uint256 soldAll;
        for (uint256 i; i < tl.eids.length; ++i) {
            Report storage r = reports[coin][tl.round][tl.eids[i]];
            total += r.money;
            soldAll += r.sold;
            if (r.money > best) {
                best = r.money;
                winner = tl.eids[i]; // ties: the lower endpoint id (list is sorted)
            }
        }
        ready = true;
        graduate = total >= tl.target && best > 0;
        if (graduate) {
            uint256 n = tl.eids.length;
            uint256 v0 = tl.v * n;
            uint256 t0 = tl.t * n;
            // poolTokens = R / P_g with P_g = (V0 + R)^2 / (V0 * T0)
            poolTokens = (total * t0 / (v0 + total)) * v0 / (v0 + total);
            if (soldAll + poolTokens > MAX_SUPPLY) poolTokens = MAX_SUPPLY - soldAll;
        }
    }

    /**
     * @notice Sends the decision to every chain of the coin. Anyone may call it once all
     * chains reported. `msg.value` pays the LayerZero fees (`feePerChain` each; the
     * endpoint refunds what is not used).
     */
    function finalize(bytes32 coin, uint256 feePerChain, bytes calldata options) external payable {
        if (localEid != coordEid) revert NotAllowed();
        (bool ready, bool graduate, uint32 winner, uint256 total, uint256 poolTokens) = preview(coin);
        if (!ready) revert NotReady();
        Tally storage tl = tallies[coin];
        uint64 round = tl.round;
        if (graduate) tl.done = true;
        else {
            tl.round = round + 1;
            tl.count = 0;
        }
        emit Decided(coin, round, graduate, winner, total, poolTokens);
        bytes memory m = graduate
            ? abi.encode(KIND_VERDICT, coin, round, winner, poolTokens, total)
            : abi.encode(KIND_REOPEN, coin, round, uint32(0), uint256(0), uint256(0));
        uint32[] memory eids = tl.eids;
        for (uint256 i; i < eids.length; ++i) {
            if (eids[i] == localEid) _onDecision(m);
            else _lzSend(eids[i], m, options, MessagingFee(feePerChain, 0), payable(msg.sender));
        }
    }

    // ------------------------------------------------------------------ step 3: settle (every chain)

    function _onDecision(bytes memory m) internal {
        (uint8 kind, bytes32 coin, uint64 round, uint32 winner, uint256 poolTokens, uint256 total) =
            abi.decode(m, (uint8, bytes32, uint64, uint32, uint256, uint256));
        Local storage l = locals[coin];
        if (l.curve == address(0)) revert Unknown();
        if (round != l.round) revert Mismatch();
        if (kind == KIND_REOPEN) {
            l.round = round + 1;
            // A chain that was never frozen this round just keeps trading.
            try ICurveV6Hub(l.curve).reopen() {} catch {}
            emit Reopened(coin, round);
        } else {
            bool isWinner = winner == localEid;
            ICurveV6Hub(l.curve).settle(winner, isWinner, isWinner ? poolTokens : 0, total);
            emit Settled(coin, winner, isWinner);
        }
    }

    // ------------------------------------------------------------------ LayerZero

    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata) internal override {
        uint8 kind = abi.decode(message[0:32], (uint8));
        if (kind == KIND_REPORT) {
            if (localEid != coordEid) revert NotAllowed();
            _onReport(message, origin.srcEid);
        } else if (kind == KIND_VERDICT || kind == KIND_REOPEN) {
            if (origin.srcEid != coordEid) revert NotAllowed(); // decisions come only from the coordinator
            _onDecision(message);
        } else {
            revert NotAllowed();
        }
    }

    /// @dev `finalize` sends several messages in one call: each is paid from the
    /// value the caller sent (the endpoint refunds any excess to the caller).
    function _payNative(uint256 nativeFee) internal view override returns (uint256) {
        if (address(this).balance < nativeFee) revert NotEnoughNative(address(this).balance);
        return nativeFee;
    }

    receive() external payable {}
}
