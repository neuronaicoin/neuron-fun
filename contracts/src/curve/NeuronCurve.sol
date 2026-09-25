// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CurveToken} from "./CurveToken.sol";

/// @notice Takes a graduating curve's native coin and tokens and turns them
/// into permanently locked DEX liquidity.
interface IGraduationMigrator {
    function migrate(address token, uint256 tokenAmount) external payable;
}

interface ICurveFactoryOperator {
    function operator() external view returns (address);
}

/**
 * @title NeuronCurve
 * @notice One coin's bonding curve on one chain. A coin launched on several
 * chains has one curve per chain; an off-chain keeper adds their volume up
 * and, when the total crosses the graduation target, graduates the curve on
 * the leading chain and closes the others.
 *
 * Pricing is a constant-product curve on virtual reserves:
 *   virtualNative * virtualToken = k   (k never decreases)
 *
 * States:
 * - Trading:   buy and sell.
 * - Closed:    buying stops, selling back to the curve stays open forever.
 *              This is what happens on the chains that did not win.
 * - Graduated: the curve's native coin and a matching amount of tokens go
 *              to the migrator, which locks them as DEX liquidity at the
 *              curve's last price. Unneeded tokens are burned.
 *
 * Guarantees, whatever the operator does:
 * - The operator cannot take anyone's money. It can only close or graduate,
 *   and graduation can only send funds to the migrator fixed at deployment.
 * - Until graduation, every holder can always sell back to the curve, and
 *   the curve always holds enough native coin to pay for it.
 *
 * Fees: `feeBps` of the native amount that enters or leaves the curve,
 * charged on top of buys and taken out of sells. Split between the creator
 * and the protocol; both are claimed, never pushed.
 */
contract NeuronCurve is ReentrancyGuard {
    enum State {
        Trading,
        Closed,
        Graduated
    }

    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ICurveFactoryOperator public immutable factory;
    CurveToken public immutable token;
    IGraduationMigrator public immutable migrator;
    address public immutable creator;
    address public immutable protocolFeeRecipient;
    bytes32 public immutable launchKey;
    uint16 public immutable feeBps;
    uint16 public immutable creatorShareBps;
    uint256 public immutable initialVirtualNative;
    uint256 public immutable initialVirtualToken;
    /// @notice The operator cannot graduate this curve holding less than this.
    uint256 public immutable minGraduationNative;

    uint256 public virtualNative;
    uint256 public virtualToken;
    /// @notice Native coin paid into the curve for tokens still outstanding.
    uint256 public realNative;
    /// @notice Tokens the curve can still sell.
    uint256 public tokensForSale;
    /// @notice Tokens held back for the DEX pool at graduation.
    uint256 public graduationTokens;

    uint256 public creatorFees;
    uint256 public protocolFees;
    State public state;

    event Trade(
        address indexed trader,
        bool indexed isBuy,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualNative,
        uint256 virtualToken
    );
    /// @param report Hash of the published cross-chain tally the decision rests on.
    event Closed(bytes32 indexed report);
    event Graduated(bytes32 indexed report, uint256 nativeToPool, uint256 tokensToPool, uint256 tokensBurned);
    event FeesClaimed(address indexed to, uint256 amount, bool creatorShare);

    error NotOperator();
    error NotTrading();
    error AlreadyGraduated();
    error ZeroAmount();
    error SoldOut();
    error Slippage(uint256 got, uint256 min);
    error TransferFailed();
    error BadConfig();
    error BelowGraduationMinimum(uint256 have, uint256 min);
    error NoReport();

    struct Params {
        string name;
        string symbol;
        string logo;
        string description;
        address creator;
        address protocolFeeRecipient;
        IGraduationMigrator migrator;
        bytes32 launchKey;
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 tokensForSale;
        uint256 graduationTokens;
        uint16 feeBps;
        uint16 creatorShareBps;
        uint256 minGraduationNative;
    }

    constructor(Params memory p) {
        if (
            p.creator == address(0) || p.protocolFeeRecipient == address(0) || address(p.migrator) == address(0)
                || p.virtualNative == 0 || p.tokensForSale == 0 || p.virtualToken <= p.tokensForSale
                || p.feeBps > 1_000 || p.creatorShareBps > BPS
        ) revert BadConfig();
        factory = ICurveFactoryOperator(msg.sender);
        migrator = p.migrator;
        creator = p.creator;
        protocolFeeRecipient = p.protocolFeeRecipient;
        launchKey = p.launchKey;
        feeBps = p.feeBps;
        creatorShareBps = p.creatorShareBps;
        initialVirtualNative = p.virtualNative;
        initialVirtualToken = p.virtualToken;
        minGraduationNative = p.minGraduationNative;
        virtualNative = p.virtualNative;
        virtualToken = p.virtualToken;
        tokensForSale = p.tokensForSale;
        graduationTokens = p.graduationTokens;
        token = new CurveToken(
            p.name, p.symbol, p.logo, p.description, p.tokensForSale + p.graduationTokens, address(this)
        );
    }

    modifier onlyOperator() {
        if (msg.sender != factory.operator()) revert NotOperator();
        _;
    }

    // ------------------------------------------------------------ trading

    /// @notice Buys tokens with all of `msg.value`. If the curve runs out,
    /// buys what is left and refunds the rest.
    function buy(uint256 minTokensOut, address recipient) external payable nonReentrant returns (uint256 tokensOut) {
        if (state != State.Trading) revert NotTrading();
        if (msg.value == 0) revert ZeroAmount();
        if (tokensForSale == 0) revert SoldOut();

        uint256 v = virtualNative;
        uint256 t = virtualToken;
        uint256 k = v * t;

        // Fee is charged on top: net + net * feeBps / BPS <= msg.value.
        uint256 net = (msg.value * BPS) / (BPS + feeBps);
        tokensOut = t - _ceilDiv(k, v + net);

        if (tokensOut >= tokensForSale) {
            tokensOut = tokensForSale;
            // Smallest net that moves the curve by exactly tokensOut.
            net = _ceilDiv(k, t - tokensOut) - v;
        }
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);

        uint256 fee = _ceilDiv(net * feeBps, BPS);
        uint256 cost = net + fee; // <= msg.value, see comment above
        uint256 refund = msg.value - cost;

        virtualNative = v + net;
        virtualToken = t - tokensOut;
        realNative += net;
        tokensForSale -= tokensOut;
        _takeFee(fee);

        emit Trade(msg.sender, true, cost, tokensOut, fee, v + net, t - tokensOut);

        _sendToken(recipient, tokensOut);
        if (refund > 0) _sendNative(msg.sender, refund);
    }

    /// @notice Sells tokens back to the curve. Open while Trading or Closed.
    /// The caller must have approved this contract for `tokenAmount`.
    function sell(uint256 tokenAmount, uint256 minNativeOut, address recipient)
        external
        nonReentrant
        returns (uint256 nativeOut)
    {
        if (state == State.Graduated) revert AlreadyGraduated();
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 v = virtualNative;
        uint256 t = virtualToken;
        uint256 gross = v - _ceilDiv(v * t, t + tokenAmount);
        // Can't happen (see testFuzz_solvency); kept as a hard stop.
        if (gross > realNative) revert BadConfig();

        // Fee is taken out: nativeOut + nativeOut * feeBps / BPS <= gross.
        nativeOut = (gross * BPS) / (BPS + feeBps);
        uint256 fee = gross - nativeOut;
        if (nativeOut == 0) revert ZeroAmount();
        if (nativeOut < minNativeOut) revert Slippage(nativeOut, minNativeOut);

        virtualNative = v - gross;
        virtualToken = t + tokenAmount;
        realNative -= gross;
        tokensForSale += tokenAmount;
        _takeFee(fee);

        emit Trade(msg.sender, false, nativeOut, tokenAmount, fee, v - gross, t + tokenAmount);

        if (!token.transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        _sendNative(recipient, nativeOut);
    }

    // ------------------------------------------------------------ quotes

    /// @notice Tokens a buy of `nativeIn` would get (before any sell-out cap).
    function quoteBuy(uint256 nativeIn) external view returns (uint256) {
        uint256 net = (nativeIn * BPS) / (BPS + feeBps);
        uint256 out = virtualToken - _ceilDiv(virtualNative * virtualToken, virtualNative + net);
        return out > tokensForSale ? tokensForSale : out;
    }

    /// @notice Native coin a sell of `tokenAmount` would pay out.
    function quoteSell(uint256 tokenAmount) external view returns (uint256) {
        uint256 gross = virtualNative - _ceilDiv(virtualNative * virtualToken, virtualToken + tokenAmount);
        return (gross * BPS) / (BPS + feeBps);
    }

    // ------------------------------------------------------------ lifecycle

    /**
     * @notice Stops buying; selling back stays open. For chains that lost.
     * @param report Hash of the published cross-chain tally (every chain's
     * curve and native total at the decision block), so anyone can check
     * the decision against the chains themselves.
     */
    function close(bytes32 report) external onlyOperator {
        if (report == bytes32(0)) revert NoReport();
        if (state != State.Trading) revert NotTrading();
        state = State.Closed;
        emit Closed(report);
    }

    /**
     * @notice Moves this curve's money into DEX liquidity at the current
     * curve price, through the migrator fixed at deployment. Tokens the pool
     * does not need are burned. Refused below `minGraduationNative`, so a
     * near-empty chain can never be made the winner.
     */
    function graduate(bytes32 report) external onlyOperator nonReentrant {
        if (report == bytes32(0)) revert NoReport();
        if (state != State.Trading) revert NotTrading();
        uint256 nativeToPool = realNative;
        if (nativeToPool < minGraduationNative) revert BelowGraduationMinimum(nativeToPool, minGraduationNative);
        state = State.Graduated;

        // Same price as the curve: tokens / native = virtualToken / virtualNative.
        uint256 tokensToPool = (nativeToPool * virtualToken) / virtualNative;
        uint256 available = graduationTokens + tokensForSale;
        if (tokensToPool > available) tokensToPool = available;
        uint256 burn = available - tokensToPool;

        realNative = 0;
        tokensForSale = 0;
        graduationTokens = 0;

        emit Graduated(report, nativeToPool, tokensToPool, burn);

        if (burn > 0) _sendToken(DEAD, burn);
        if (tokensToPool > 0) _sendToken(address(migrator), tokensToPool);
        migrator.migrate{value: nativeToPool}(address(token), tokensToPool);
    }

    // ------------------------------------------------------------ fees

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFees;
        creatorFees = 0;
        if (amount > 0) {
            emit FeesClaimed(creator, amount, true);
            _sendNative(creator, amount);
        }
    }

    function claimProtocolFees() external nonReentrant returns (uint256 amount) {
        amount = protocolFees;
        protocolFees = 0;
        if (amount > 0) {
            emit FeesClaimed(protocolFeeRecipient, amount, false);
            _sendNative(protocolFeeRecipient, amount);
        }
    }

    // ------------------------------------------------------------ internals

    function _takeFee(uint256 fee) private {
        uint256 toCreator = (fee * creatorShareBps) / BPS;
        creatorFees += toCreator;
        protocolFees += fee - toCreator;
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _sendToken(address to, uint256 amount) private {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
