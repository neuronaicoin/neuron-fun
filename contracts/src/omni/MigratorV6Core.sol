// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHubLocal} from "./ConsolidatorV6.sol";

interface ICurveV6Info {
    function coin() external view returns (address);
    function creator() external view returns (address);
    function feeMode() external view returns (uint8);
}

interface ICoinBurn {
    function burn(uint256 amount) external;
}

/**
 * @title MigratorV6Core
 * @notice The winning chain's side of graduation: gathers a coin's money from every
 * chain and opens its locked pool at the graduation price P_g.
 *
 * - The winning curve hands over its money and the pool coins, and says how much
 *   was raised over all chains (`total`, decided on-chain by the coordinator).
 * - Money from the other chains arrives through the bridge adapter, tagged with its
 *   coin. It may arrive before or after the curve's hand-over.
 * - The pool opens (anyone may trigger it) once 99% of the total is here (bridges
 *   keep a little), or 30 minutes after graduation with whatever arrived. Pool coins
 *   are used in proportion to the money, so the price is always P_g = total / poolTokens;
 *   the rest are burned.
 * - Money arriving after the pool opened buys the coin back and burns it, like buyback fees.
 *
 * The pool itself (Uniswap v4, locked forever) is created by `_openPool` in the
 * concrete migrator, reusing the v5 migrator's audited steps.
 */
abstract contract MigratorV6Core is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant READY_BPS = 9_900;
    uint256 public constant OPEN_WAIT = 30 minutes;
    /// @notice sasa's graduation fee: 2% of the money going to the pool, sent to the treasury.
    /// The same share of the pool's coins is burned, so the pool still opens at P_g.
    uint256 public constant GRAD_FEE_BPS = 200;

    IERC20 public immutable usdc;
    IHubLocal public immutable hub;
    /// @notice The only contract allowed to report money arriving from other chains.
    address public immutable bridge;

    struct Grad {
        address token;
        bool known;
        bool opened;
        uint64 deadline;
        address creator;
        uint8 feeMode;
        uint256 expected;
        uint256 received;
        uint256 tokens;
    }

    mapping(bytes32 coin => Grad) public grads;
    /// @notice Money that arrived from another chain before this chain's hand-over.
    mapping(bytes32 coin => uint256) public early;
    /// @notice USDC waiting to buy back and burn each coin.
    mapping(bytes32 coin => uint256) public buybackFunds;
    /// @dev All USDC held for coins (pool money not yet used, early money, buyback funds).
    uint256 internal _held;

    event HandedOver(bytes32 indexed coin, uint256 money, uint256 poolTokens, uint256 total);
    event Arrived(bytes32 indexed coin, uint256 amount, bool buyback, bool late);
    event PoolOpened(bytes32 indexed coin, uint256 usdcIn, uint256 tokensIn, uint256 tokensBurned);
    event GraduationFee(bytes32 indexed coin, address indexed to, uint256 amount);
    event BuybackFunded(bytes32 indexed coin, uint256 amount);

    error NotTheCurve();
    error NotBridge();
    error AlreadyKnown();
    error NotReady();
    error NotDelivered();

    constructor(IERC20 usdc_, IHubLocal hub_, address bridge_) {
        usdc = usdc_;
        hub = hub_;
        bridge = bridge_;
    }

    function _curveOf(bytes32 coin) internal view returns (address curve) {
        (curve,,,) = hub.localOf(coin);
        if (curve == address(0) || curve != msg.sender) revert NotTheCurve();
    }

    // ------------------------------------------------------------ hand-over and arrivals

    function fromCurve(bytes32 coin, uint256 money, uint256 poolTokens, uint256 total) external nonReentrant {
        address curve = _curveOf(coin);
        Grad storage g = grads[coin];
        if (g.known) revert AlreadyKnown();
        if (usdc.balanceOf(address(this)) < _held + money) revert NotDelivered();
        g.token = ICurveV6Info(curve).coin();
        g.known = true;
        g.deadline = uint64(block.timestamp + OPEN_WAIT);
        g.creator = ICurveV6Info(curve).creator();
        g.feeMode = ICurveV6Info(curve).feeMode();
        g.expected = total;
        g.received = money + early[coin];
        g.tokens = poolTokens;
        early[coin] = 0;
        if (IERC20(g.token).balanceOf(address(this)) < poolTokens) revert NotDelivered();
        _held += money;
        emit HandedOver(coin, money, poolTokens, total);
    }

    /// @notice Called by the bridge adapter after it delivered `amount` USDC here.
    function receiveConsolidated(bytes32 coin, uint256 amount, bool buyback) external nonReentrant {
        if (msg.sender != bridge) revert NotBridge();
        if (usdc.balanceOf(address(this)) < _held + amount) revert NotDelivered();
        _held += amount;
        Grad storage g = grads[coin];
        bool late = g.opened;
        if (buyback || late) {
            buybackFunds[coin] += amount;
            emit BuybackFunded(coin, amount);
        } else if (!g.known) {
            early[coin] += amount;
        } else {
            g.received += amount;
        }
        emit Arrived(coin, amount, buyback, late);
    }

    /// @notice The winning curve's buyback share (pulled from it).
    function depositBuyback(bytes32 coin, uint256 amount) external nonReentrant {
        _curveOf(coin);
        if (amount == 0) return;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _held += amount;
        buybackFunds[coin] += amount;
        emit BuybackFunded(coin, amount);
    }

    // ------------------------------------------------------------ opening

    function ready(bytes32 coin) public view returns (bool) {
        Grad storage g = grads[coin];
        if (!g.known || g.opened || g.received == 0) return false;
        return g.received * BPS >= g.expected * READY_BPS || block.timestamp >= g.deadline;
    }

    /// @notice Opens the coin's locked pool at P_g. Anyone may call it once `ready`.
    function open(bytes32 coin) external nonReentrant {
        if (!ready(coin)) revert NotReady();
        Grad storage g = grads[coin];
        g.opened = true;
        uint256 money = g.received;
        // Same price as decided: coins in proportion to the money that arrived.
        uint256 tokens = g.received >= g.expected ? g.tokens : (g.tokens * money) / g.expected;
        _held -= money;
        // Graduation fee: 2% of the money to the treasury, 2% of the coins burned (price unchanged).
        uint256 fee = (money * GRAD_FEE_BPS) / BPS;
        address feeTo = _gradFeeTo();
        if (feeTo == address(0)) fee = 0;
        uint256 feeTokens = fee == 0 ? 0 : (tokens * GRAD_FEE_BPS) / BPS;
        money -= fee;
        tokens -= feeTokens;
        uint256 burn = g.tokens - tokens;
        if (fee > 0) {
            usdc.safeTransfer(feeTo, fee);
            emit GraduationFee(coin, feeTo, fee);
        }
        if (burn > 0) ICoinBurn(g.token).burn(burn);
        emit PoolOpened(coin, money, tokens, burn);
        _openPool(coin, g.token, tokens, money);
    }

    /// @dev Where the graduation fee goes (address(0): no fee).
    function _gradFeeTo() internal view virtual returns (address) {
        return address(0);
    }

    /// @dev Creates the locked pool with exactly these amounts (both already held here).
    function _openPool(bytes32 coin, address token, uint256 tokens, uint256 money) internal virtual;
}
