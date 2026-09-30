// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UsdCurve, IUsdMigrator} from "./UsdCurve.sol";

/**
 * @title NeuronCurveFactory
 * @notice Creates coins on this chain. A coin launched on several chains is
 * created once per chain with the same `launchKey`; the keeper groups curves
 * by (creator, launchKey) across chains.
 *
 * The owner sets terms for future launches only. Every curve freezes its
 * terms, fee recipient and migrator when it is created.
 *
 * Beta safety (v3):
 * - Pause: the guardian (a hot key, for emergencies) or the owner can stop
 *   new launches and buys on every curve of this factory. Selling, fee
 *   claims, closing and graduation are never paused, so nobody's money is
 *   ever stuck. Only the owner (the Safe) can unpause.
 * - Total cap: the native coin held by all curves together can't go above
 *   `nativeCap` through buys (0 = no cap). Sells always work.
 * - Owner: meant to be a Safe multisig (two-step transfer, can't renounce).
 */
/// @dev USD edition (v5): coins trade against USDC. The creator's first buy is
/// paid in USDC (approve this factory first). "Native" in names means USDC.
contract UsdCurveFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The money every coin of this factory trades against (USDC).
    IERC20 public immutable quote;
    struct Config {
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 tokensForSale;
        uint256 graduationTokens;
        uint16 feeBps;
        uint16 creatorShareBps;
        uint256 minGraduationNative;
    }

    IUsdMigrator public immutable migrator;
    Config public config;
    address public operator;
    address public protocolFeeRecipient;
    bool public launchesOpen;

    mapping(address curve => bool) public isCurve;
    address[] public allCurves;

    /// @notice Can pause buys and launches, nothing else.
    address public guardian;
    /// @notice When true, launches and buys stop; everything else stays open.
    bool public buysPaused;
    /// @notice Most native coin all curves may hold together (0 = no cap).
    uint256 public nativeCap;
    /// @notice Native coin currently held by all curves for their holders.
    uint256 public totalNative;

    event Launched(
        address indexed curve,
        address indexed token,
        address indexed creator,
        bytes32 launchKey,
        string name,
        string symbol,
        UsdCurve.FeeMode feeMode
    );
    event ConfigSet(Config config);
    event OperatorSet(address operator);
    event ProtocolFeeRecipientSet(address recipient);
    event LaunchesOpenSet(bool open);
    event GuardianSet(address guardian);
    /// @notice The creator's coins in `token` can't move until `until`.
    event CreatorLocked(address indexed curve, address indexed token, address indexed creator, uint256 until);
    event BuysPausedSet(bool paused, address by);
    event NativeCapSet(uint256 cap);

    error ZeroAddress();
    error NotGuardian();
    error NotCurve();
    error BuysPaused();
    error CapReached(uint256 total, uint256 cap);
    error LaunchesClosed();
    error BadConfig();
    error RenounceDisabled();

    constructor(
        address owner_,
        IUsdMigrator migrator_,
        address operator_,
        address protocolFeeRecipient_,
        Config memory config_,
        IERC20 quote_
    ) Ownable(owner_) {
        if (
            address(migrator_) == address(0) || operator_ == address(0) || protocolFeeRecipient_ == address(0)
                || address(quote_) == address(0)
        ) {
            revert ZeroAddress();
        }
        quote = quote_;
        migrator = migrator_;
        operator = operator_;
        protocolFeeRecipient = protocolFeeRecipient_;
        _setConfig(config_);
        emit OperatorSet(operator_);
        emit ProtocolFeeRecipientSet(protocolFeeRecipient_);
    }

    /**
     * @notice Creates a coin and its curve. Anything sent with the call is
     * the creator's first buy, at the same price as everyone else.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey,
        uint256 firstBuy,
        uint256 minTokensOut,
        UsdCurve.FeeMode feeMode
    ) external nonReentrant returns (address curve, address token, uint256 tokensBought) {
        return _launch(name, symbol, logo, description, launchKey, firstBuy, minTokensOut, feeMode, 0);
    }

    /**
     * @notice Like `launch`, with the creator's coins locked for `lockSeconds`
     * (up to one day): they can't be sold or moved until then. The first buy
     * made here lands in the locked wallet too.
     */
    function launchLocked(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey,
        uint256 firstBuy,
        uint256 minTokensOut,
        UsdCurve.FeeMode feeMode,
        uint256 lockSeconds
    ) external nonReentrant returns (address curve, address token, uint256 tokensBought) {
        return _launch(name, symbol, logo, description, launchKey, firstBuy, minTokensOut, feeMode, lockSeconds);
    }

    function _launch(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey,
        uint256 firstBuy,
        uint256 minTokensOut,
        UsdCurve.FeeMode feeMode,
        uint256 lockSeconds
    ) private returns (address curve, address token, uint256 tokensBought) {
        if (!launchesOpen) revert LaunchesClosed();
        if (buysPaused) revert BuysPaused();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert BadConfig();
        UsdCurve.Params memory p = _params(name, symbol, logo, description, launchKey, feeMode);
        p.creatorLock = lockSeconds;
        UsdCurve created = new UsdCurve(p);
        curve = address(created);
        token = address(created.token());
        isCurve[curve] = true;
        allCurves.push(curve);
        emit Launched(curve, token, msg.sender, launchKey, name, symbol, feeMode);
        if (lockSeconds > 0) emit CreatorLocked(curve, token, msg.sender, block.timestamp + lockSeconds);

        if (firstBuy > 0) {
            // The creator's first buy: pull their USDC, buy for them, and hand
            // back anything the curve didn't need (a sell-out buys less).
            quote.safeTransferFrom(msg.sender, address(this), firstBuy);
            uint256 before = quote.balanceOf(address(this)) - firstBuy;
            quote.forceApprove(curve, firstBuy);
            tokensBought = created.buy(firstBuy, minTokensOut, msg.sender);
            quote.forceApprove(curve, 0);
            uint256 left = quote.balanceOf(address(this)) - before;
            if (left > 0) quote.safeTransfer(msg.sender, left);
        }
    }

    function _params(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey,
        UsdCurve.FeeMode feeMode
    ) private view returns (UsdCurve.Params memory p) {
        Config memory c = config;
        p.name = name;
        p.symbol = symbol;
        p.logo = logo;
        p.description = description;
        p.creator = msg.sender;
        p.feeMode = feeMode;
        p.protocolFeeRecipient = protocolFeeRecipient;
        p.migrator = migrator;
        p.quote = quote;
        p.launchKey = launchKey;
        p.virtualNative = c.virtualNative;
        p.virtualToken = c.virtualToken;
        p.tokensForSale = c.tokensForSale;
        p.graduationTokens = c.graduationTokens;
        p.feeBps = c.feeBps;
        p.creatorShareBps = c.creatorShareBps;
        p.minGraduationNative = c.minGraduationNative;
    }

    function curveCount() external view returns (uint256) {
        return allCurves.length;
    }

    /// @notice Room left under the total cap (max uint if there is no cap).
    function capRoom() external view returns (uint256) {
        if (nativeCap == 0) return type(uint256).max;
        return nativeCap > totalNative ? nativeCap - totalNative : 0;
    }

    // ------------------------------------------------------------ curve hooks

    /// @notice A curve took in `amount` for its holders. Buys pass
    /// `enforceCap = true`; fee buybacks pass false so a claim never fails.
    function noteNativeIn(uint256 amount, bool enforceCap) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        uint256 total = totalNative + amount;
        if (enforceCap && nativeCap != 0 && total > nativeCap) revert CapReached(total, nativeCap);
        totalNative = total;
    }

    /// @notice A curve paid out `amount` (a sell or its graduation).
    function noteNativeOut(uint256 amount) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        totalNative = amount >= totalNative ? 0 : totalNative - amount;
    }

    // ------------------------------------------------------------ safety

    /// @notice Emergency stop for launches and buys. Selling stays open.
    function pauseBuys() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        buysPaused = true;
        emit BuysPausedSet(true, msg.sender);
    }

    function unpauseBuys() external onlyOwner {
        buysPaused = false;
        emit BuysPausedSet(false, msg.sender);
    }

    /// @param g Zero address removes the guardian.
    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    /// @param cap Zero removes the cap.
    function setNativeCap(uint256 cap) external onlyOwner {
        nativeCap = cap;
        emit NativeCapSet(cap);
    }

    // ------------------------------------------------------------ admin

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setOperator(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        operator = o;
        emit OperatorSet(o);
    }

    function setProtocolFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        protocolFeeRecipient = r;
        emit ProtocolFeeRecipientSet(r);
    }

    function setLaunchesOpen(bool open) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }


    function _setConfig(Config memory c) private {
        if (
            c.virtualNative == 0 || c.tokensForSale == 0 || c.virtualToken <= c.tokensForSale || c.feeBps > 1_000
                || c.creatorShareBps > 10_000
        ) revert BadConfig();
        config = c;
        emit ConfigSet(c);
    }
}
