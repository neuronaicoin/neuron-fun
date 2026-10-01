// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchCoin} from "./LaunchCoin.sol";

/// @notice Beta locks shared with v5: buys can be paused and a hidden total cap applies.
interface ICurveFactoryV6 {
    function buysPaused() external view returns (bool);
    function noteNativeIn(uint256 amount, bool enforceCap) external;
    function noteNativeOut(uint256 amount) external;
}

/// @notice Takes buyback money and spends it buying the coin back in its pool and burning it.
/// The migrator does it on the winning chain; the consolidator forwards it there from the others.
interface IBuybackSink {
    function depositBuyback(bytes32 coinId, uint256 amount) external;
}

/// @notice Graduation receivers are told what they just got, so money is always tied to its coin.
interface IMigratorV6In {
    function fromCurve(bytes32 coinId, uint256 money, uint256 poolTokens, uint256 total) external;
}

interface IConsolidatorV6In {
    function fromCurve(bytes32 coinId, uint256 money) external;
}

/**
 * @title UsdCurveV6
 * @notice One omnichain coin's bonding curve on one chain (USDC, 6 decimals).
 *
 * Differences from v5 (see the v6 design doc):
 * - Coins are minted when bought and burned when sold back, so only coins people
 *   hold exist. A chain's sales are capped at `saleCap` (set by the factory from the
 *   graduation target, with room for late buys). With every chain's curve scaled to
 *   1/N of the reference curve, the coins sold over all chains can never exceed what
 *   one reference curve would sell for the same money.
 * - The lifecycle is driven by this chain's OmniHub, which relays to and from the
 *   coordinator over LayerZero:
 *     Trading --freeze--> Frozen --reopen--> Trading     (total was short of the target)
 *                         Frozen --settle--> Settled     (graduated: winner or loser)
 *   While Frozen nothing trades, so the totals the hub reports cannot move.
 * - At settlement all of the curve's trading money leaves: to the local migrator on
 *   the winning chain, or to the local consolidator (which bridges it to the
 *   winner's migrator) on the others. The coin's bridge opens, naming the winner.
 *
 * Guarantees, whatever the hub or the operator does:
 * - Money only ever goes to buyers/sellers, the fee recipients, or the migrator /
 *   consolidator fixed at deployment.
 * - Until the coin graduates, a seller can always sell back: the curve always holds
 *   the money for every coin it sold (realNative).
 * - Fee money is never touched by graduation and can always be claimed.
 *
 * Creator fee modes (chosen at launch, never change):
 * - Creator: the creator's share is paid to the creator.
 * - Buyback: the share builds up until graduation, then all of it (and every later
 *   share) buys the coin back in its locked pool and burns it. If the coin has not
 *   graduated 30 days after launch, the creator can take what built up instead.
 */
contract UsdCurveV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        Trading,
        Frozen,
        Settled
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant BUYBACK_FALLBACK = 30 days;

    enum FeeMode {
        Creator,
        Buyback
    }

    IERC20 public immutable quote;
    LaunchCoin public immutable coin;
    /// @notice The coin's id, the same on every chain (keys it at the hub, migrator and consolidator).
    bytes32 public immutable coinId;
    ICurveFactoryV6 public immutable factory;
    address public immutable hub;
    address public immutable migrator;
    address public immutable consolidator;
    address public immutable creator;
    address public immutable protocolFeeRecipient;
    uint16 public immutable feeBps;
    uint16 public immutable creatorShareBps;
    uint256 public immutable initialVirtualNative;
    uint256 public immutable initialVirtualToken;
    /// @notice Most coins this chain's curve may ever have out at once.
    uint256 public immutable saleCap;
    FeeMode public immutable feeMode;
    uint256 public immutable launchedAt;

    uint256 public virtualNative;
    uint256 public virtualToken;
    /// @notice USDC paid in for the coins still out (what sellers can take back).
    uint256 public realNative;
    /// @notice Coins sold by this curve and not sold back.
    uint256 public sold;
    uint256 public creatorFees;
    uint256 public protocolFees;
    State public state;
    /// @notice Winning chain's LayerZero endpoint id, once settled.
    uint32 public winnerEid;
    /// @notice True once settled as the winning chain.
    bool public won;

    struct Params {
        IERC20 quote;
        LaunchCoin coin;
        bytes32 coinId;
        /// @notice The OmniFactory (beta locks); the curve may be created by its helper.
        address factory;
        address hub;
        address migrator;
        address consolidator;
        address creator;
        address protocolFeeRecipient;
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 saleCap;
        uint16 feeBps;
        uint16 creatorShareBps;
        FeeMode feeMode;
    }

    event Trade(
        address indexed trader,
        bool indexed isBuy,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualNative,
        uint256 virtualToken
    );
    event Frozen(uint256 realNative, uint256 sold);
    event Reopened();
    event Settled(uint32 winnerEid, bool winner, uint256 moneyOut, uint256 poolTokens);
    event FeesClaimed(address indexed to, uint256 amount, bool creatorShare);
    event BuybackForwarded(address indexed sink, uint256 amount);

    error NotHub();
    error NotTrading();
    error NotFrozen();
    error ZeroAmount();
    error SoldOut();
    error Slippage(uint256 got, uint256 min);
    error BadConfig();
    error BuysPaused();

    constructor(Params memory p) {
        if (
            address(p.quote) == address(0) || address(p.coin) == address(0) || p.hub == address(0) || p.factory == address(0)
                || p.migrator == address(0) || p.consolidator == address(0) || p.creator == address(0)
                || p.protocolFeeRecipient == address(0) || p.virtualNative == 0 || p.saleCap == 0
                || p.virtualToken <= p.saleCap || p.feeBps > 1_000 || p.creatorShareBps > BPS
        ) revert BadConfig();
        quote = p.quote;
        coin = p.coin;
        coinId = p.coinId;
        factory = ICurveFactoryV6(p.factory);
        hub = p.hub;
        migrator = p.migrator;
        consolidator = p.consolidator;
        creator = p.creator;
        protocolFeeRecipient = p.protocolFeeRecipient;
        feeBps = p.feeBps;
        creatorShareBps = p.creatorShareBps;
        initialVirtualNative = p.virtualNative;
        initialVirtualToken = p.virtualToken;
        virtualNative = p.virtualNative;
        virtualToken = p.virtualToken;
        saleCap = p.saleCap;
        feeMode = p.feeMode;
        launchedAt = block.timestamp;
    }

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    // ------------------------------------------------------------ trading

    /// @notice Buys coins for up to `amountIn` USDC (approve this curve first). Only what is
    /// spent is pulled: if the chain's cap is reached, the rest stays with the caller.
    function buy(uint256 amountIn, uint256 minTokensOut, address recipient)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (state != State.Trading) revert NotTrading();
        if (amountIn == 0) revert ZeroAmount();
        uint256 room = saleCap - sold;
        if (room == 0) revert SoldOut();
        if (factory.buysPaused()) revert BuysPaused();
        uint256 v = virtualNative;
        uint256 t = virtualToken;
        uint256 k = v * t;
        uint256 net = (amountIn * BPS) / (BPS + feeBps);
        tokensOut = t - _ceilDiv(k, v + net);
        if (tokensOut >= room) {
            tokensOut = room;
            net = _ceilDiv(k, t - tokensOut) - v;
        }
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);
        uint256 fee = _ceilDiv(net * feeBps, BPS);
        uint256 cost = net + fee;
        virtualNative = v + net;
        virtualToken = t - tokensOut;
        realNative += net;
        sold += tokensOut;
        _takeFee(fee);
        factory.noteNativeIn(net, true);
        emit Trade(msg.sender, true, cost, tokensOut, fee, v + net, t - tokensOut);
        quote.safeTransferFrom(msg.sender, address(this), cost);
        coin.mint(recipient, tokensOut);
    }

    /// @notice Sells coins back (approve this curve for the coins first). Open while Trading.
    function sell(uint256 tokenAmount, uint256 minNativeOut, address recipient)
        external
        nonReentrant
        returns (uint256 nativeOut)
    {
        if (state != State.Trading) revert NotTrading();
        if (tokenAmount == 0) revert ZeroAmount();
        uint256 v = virtualNative;
        uint256 t = virtualToken;
        uint256 gross = v - _ceilDiv(v * t, t + tokenAmount);
        if (gross > realNative || tokenAmount > sold) revert BadConfig(); // cannot happen; hard stop
        nativeOut = (gross * BPS) / (BPS + feeBps);
        uint256 fee = gross - nativeOut;
        if (nativeOut == 0) revert ZeroAmount();
        if (nativeOut < minNativeOut) revert Slippage(nativeOut, minNativeOut);
        virtualNative = v - gross;
        virtualToken = t + tokenAmount;
        realNative -= gross;
        sold -= tokenAmount;
        _takeFee(fee);
        factory.noteNativeOut(gross);
        emit Trade(msg.sender, false, nativeOut, tokenAmount, fee, v - gross, t + tokenAmount);
        IERC20(address(coin)).safeTransferFrom(msg.sender, address(this), tokenAmount);
        coin.burn(tokenAmount);
        quote.safeTransfer(recipient, nativeOut);
    }

    function quoteBuy(uint256 nativeIn) external view returns (uint256) {
        uint256 net = (nativeIn * BPS) / (BPS + feeBps);
        uint256 out = virtualToken - _ceilDiv(virtualNative * virtualToken, virtualNative + net);
        uint256 room = saleCap - sold;
        return out > room ? room : out;
    }

    function quoteSell(uint256 tokenAmount) external view returns (uint256) {
        uint256 gross = virtualNative - _ceilDiv(virtualNative * virtualToken, virtualToken + tokenAmount);
        return (gross * BPS) / (BPS + feeBps);
    }

    // ------------------------------------------------------------ lifecycle (hub only)

    /// @notice Stops all trading so the totals can be reported. Returns them.
    function freeze() external onlyHub returns (uint256 money, uint256 coinsSold) {
        if (state != State.Trading) revert NotTrading();
        state = State.Frozen;
        emit Frozen(realNative, sold);
        return (realNative, sold);
    }

    /// @notice The coordinator found the total short of the target: trading resumes.
    function reopen() external onlyHub {
        if (state != State.Frozen) revert NotFrozen();
        state = State.Trading;
        emit Reopened();
    }

    /**
     * @notice Graduation. On the winning chain the money goes to the migrator together
     * with `poolTokens` new coins (computed by the coordinator from the total raised;
     * capped by the coin's 1B limit). On the other chains it goes to the consolidator.
     * The coin's bridge opens either way, naming the winner.
     */
    /// @param total Money raised over all chains (the migrator waits for it before opening the pool).
    function settle(uint32 winner, bool isWinner, uint256 poolTokens, uint256 total) external onlyHub nonReentrant {
        if (state != State.Frozen) revert NotFrozen();
        state = State.Settled;
        winnerEid = winner;
        won = isWinner;
        uint256 money = realNative;
        realNative = 0;
        factory.noteNativeOut(money);
        emit Settled(winner, isWinner, money, isWinner ? poolTokens : 0);
        coin.openBridge(winner);
        if (isWinner) {
            if (poolTokens > 0) coin.mint(migrator, poolTokens);
            if (money > 0) quote.safeTransfer(migrator, money);
            IMigratorV6In(migrator).fromCurve(coinId, money, poolTokens, total);
        } else {
            if (money > 0) quote.safeTransfer(consolidator, money);
            IConsolidatorV6In(consolidator).fromCurve(coinId, money);
        }
    }

    // ------------------------------------------------------------ fees

    /// @notice Moves the creator's share where the fee mode says. Anyone can call it.
    /// Buyback mode before graduation: waits (returns 0), unless 30 days passed.
    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFees;
        if (amount == 0) return 0;
        if (feeMode == FeeMode.Buyback) {
            if (state == State.Settled) {
                creatorFees = 0;
                address sink = won ? migrator : consolidator;
                emit BuybackForwarded(sink, amount);
                quote.forceApprove(sink, amount);
                IBuybackSink(sink).depositBuyback(coinId, amount);
                quote.forceApprove(sink, 0);
                return amount;
            }
            if (block.timestamp < launchedAt + BUYBACK_FALLBACK) return 0;
        }
        creatorFees = 0;
        emit FeesClaimed(creator, amount, true);
        quote.safeTransfer(creator, amount);
    }

    function claimProtocolFees() external nonReentrant returns (uint256 amount) {
        amount = protocolFees;
        protocolFees = 0;
        if (amount > 0) {
            emit FeesClaimed(protocolFeeRecipient, amount, false);
            quote.safeTransfer(protocolFeeRecipient, amount);
        }
    }

    // ------------------------------------------------------------ internals

    function _takeFee(uint256 fee) private {
        uint256 toCreator = (fee * creatorShareBps) / BPS;
        creatorFees += toCreator;
        protocolFees += fee - toCreator;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
