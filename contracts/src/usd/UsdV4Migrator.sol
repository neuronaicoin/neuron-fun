// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {UsdCurve, IUsdMigrator} from "./UsdCurve.sol";
import {UsdToken} from "./UsdToken.sol";
import {NeuronGraduationHook} from "../curve/NeuronGraduationHook.sol";

/// @notice The pool router (UsdPoolRouter) buybacks go through.
interface IUsdBuybackRouter {
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        returns (uint256 tokensOut);
}

interface IUsdCurveRegistry {
    function isCurve(address curve) external view returns (bool);
}

/**
 * @title UsdV4Migrator
 * @notice USD edition (v5) of NeuronV4Migrator. Turns a graduating curve into
 * a Uniswap v4 coin/USDC pool with full-range liquidity locked forever.
 *
 * Same rules as v4:
 * - Only curves of the paired factory can call `migrate`, once per coin.
 * - 1% fee pool keyed to this migrator's own hook, so nobody can create it
 *   before graduation. Opening price = the curve's last price.
 * - The position NFT stays in this contract, which cannot move it or remove
 *   liquidity. Trading fees can be collected by anyone and are split between
 *   the creator side (by the coin's fee mode) and the protocol.
 *
 * Unlike the native pool (where the native coin is always currency0), the
 * order of coin and USDC depends on their addresses; every step below reads
 * it from `usdcIsCurrency0(token)`.
 */
contract UsdV4Migrator is IUsdMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant DEADLINE_WINDOW = 300;
    /// @notice Largest single pool buyback, as a share of the pool's USDC side (0.5%).
    uint256 public constant BUYBACK_CHUNK_BPS = 50;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    IERC20 public immutable usdc;
    NeuronGraduationHook public immutable hook;
    address public immutable protocolFeeRecipient;
    uint16 public immutable creatorShareBps;
    address private immutable deployer;

    IUsdCurveRegistry public curves;
    IUsdBuybackRouter public router;

    struct Position {
        uint256 tokenId;
        address creator;
    }

    mapping(address token => Position) public positions;
    mapping(address token => UsdCurve.FeeMode) public feeModes;
    /// @notice USDC waiting to buy back and burn each coin (buyback mode).
    mapping(address token => uint256) public buybackFunds;
    /// @notice USDC fees a recipient couldn't receive at collection time.
    mapping(address recipient => uint256) public usdcOwed;
    /// @notice USDC rounding dust that did not fit a position; locked here.
    uint256 public lockedUsdcDust;
    /// @dev All USDC this contract holds on someone's behalf (funds, owed, dust).
    uint256 private _usdcHeld;

    event Migrated(address indexed token, uint256 indexed tokenId, uint256 usdcIn, uint256 tokensIn, uint160 sqrtPriceX96);
    event FeesCollected(address indexed token, uint256 usdcFees, uint256 tokenFees);
    event UsdcOwed(address indexed recipient, uint256 amount);
    event BuybackFunded(address indexed token, uint256 amount);
    event BuybackDone(address indexed token, uint256 usdcSpent, uint256 tokensBurned);
    event HolderRewardsSent(address indexed token, uint256 amount);

    error ZeroAddress();
    error NotACurve();
    error WrongToken();
    error AlreadyMigrated();
    error NothingToMigrate();
    error NotDelivered();
    error BadHookAddress(address hook);
    error BadShare();
    error NotMigrated();
    error NothingOwed();
    error NotDeployer();
    error AlreadyBound();
    error NoRouter();
    error NothingToBuyBack();

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        IERC20 usdc_,
        address protocolFeeRecipient_,
        uint16 creatorShareBps_,
        bytes32 hookSalt
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || address(usdc_) == address(0) || protocolFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (creatorShareBps_ > BPS) revert BadShare();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        usdc = usdc_;
        protocolFeeRecipient = protocolFeeRecipient_;
        creatorShareBps = creatorShareBps_;
        deployer = msg.sender;
        hook = new NeuronGraduationHook{salt: hookSalt}(address(poolManager_), address(this));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != Hooks.BEFORE_INITIALIZE_FLAG) {
            revert BadHookAddress(address(hook));
        }
    }

    // ------------------------------------------------------------ binding (deployer, once)

    function bindCurves(IUsdCurveRegistry curves_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(curves) != address(0)) revert AlreadyBound();
        if (address(curves_) == address(0)) revert ZeroAddress();
        curves = curves_;
    }

    function bindRouter(IUsdBuybackRouter router_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(router) != address(0)) revert AlreadyBound();
        if (address(router_) == address(0)) revert ZeroAddress();
        router = router_;
    }

    // ------------------------------------------------------------ pool

    /// @notice True when USDC sorts before `token` (then USDC is currency0).
    function usdcIsCurrency0(address token) public view returns (bool) {
        return address(usdc) < token;
    }

    /// @notice The pool a graduated `token` trades in.
    function poolKeyFor(address token) public view returns (PoolKey memory) {
        bool u0 = usdcIsCurrency0(token);
        return PoolKey({
            currency0: Currency.wrap(u0 ? address(usdc) : token),
            currency1: Currency.wrap(u0 ? token : address(usdc)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// @inheritdoc IUsdMigrator
    /// @dev The curve has already sent `tokenAmount` coins and `quoteAmount` USDC here.
    function migrate(address token, uint256 tokenAmount, uint256 quoteAmount) external nonReentrant {
        if (address(curves) == address(0) || !curves.isCurve(msg.sender)) revert NotACurve();
        if (address(UsdCurve(msg.sender).token()) != token) revert WrongToken();
        if (positions[token].tokenId != 0) revert AlreadyMigrated();
        if (quoteAmount == 0 || tokenAmount == 0) revert NothingToMigrate();
        // The USDC must really be here, beyond what we already hold for others.
        uint256 usdcBefore = usdc.balanceOf(address(this));
        if (usdcBefore < _usdcHeld + quoteAmount) revert NotDelivered();
        if (IERC20(token).balanceOf(address(this)) < tokenAmount) revert NotDelivered();

        PoolKey memory key = poolKeyFor(token);
        bool u0 = usdcIsCurrency0(token);
        uint256 amount0 = u0 ? quoteAmount : tokenAmount;
        uint256 amount1 = u0 ? tokenAmount : quoteAmount;

        uint160 sqrtPriceX96 = _sqrtPrice(amount1, amount0);
        poolManager.initialize(key, sqrtPriceX96);

        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        int24 tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
        if (liquidity == 0) revert NothingToMigrate();

        _approveForMint(token, tokenAmount);
        _approveForMint(address(usdc), quoteAmount);

        uint256 tokenId = positionManager.nextTokenId();
        positions[token] = Position({tokenId: tokenId, creator: UsdCurve(msg.sender).creator()});
        feeModes[token] = UsdCurve(msg.sender).feeMode();

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(amount0), uint128(amount1), address(this), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + DEADLINE_WINDOW);

        // What did not fit: USDC stays here locked; coins are burned.
        uint256 usdcLeft = usdc.balanceOf(address(this)) - (usdcBefore - quoteAmount);
        lockedUsdcDust += usdcLeft;
        _usdcHeld += usdcLeft;
        uint256 tokensLeft = IERC20(token).balanceOf(address(this));
        if (tokensLeft > 0) IERC20(token).safeTransfer(DEAD, tokensLeft);
        IERC20(token).forceApprove(address(permit2), 0);
        usdc.forceApprove(address(permit2), 0);

        emit Migrated(token, tokenId, quoteAmount - usdcLeft, tokenAmount - tokensLeft, sqrtPriceX96);
    }

    // ------------------------------------------------------------ buyback

    /// @inheritdoc IUsdMigrator
    /// @dev Pulls `amount` USDC from the caller (a curve forwarding its buyback fund).
    function depositBuyback(address token, uint256 amount) external nonReentrant {
        if (amount == 0) return;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        buybackFunds[token] += amount;
        _usdcHeld += amount;
        emit BuybackFunded(token, amount);
    }

    /// @notice Spends one chunk of a coin's buyback money in its pool and burns the coins.
    /// Anyone can call it. Each chunk is capped at 0.5% of the pool's USDC side, so
    /// its price move stays under the 2% round-trip fee; the minimum output comes
    /// from the pool price, not from the caller.
    function buyback(address token) external nonReentrant returns (uint256 spent, uint256 burned) {
        if (address(router) == address(0)) revert NoRouter();
        uint256 fund = buybackFunds[token];
        if (fund == 0 || positions[token].tokenId == 0) revert NothingToBuyBack();

        PoolId id = poolKeyFor(token).toId();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        uint128 liquidity = poolManager.getLiquidity(id);
        bool u0 = usdcIsCurrency0(token);
        // USDC side of a full-range position: L / sqrtP if USDC is currency0, else L * sqrtP.
        uint256 usdcSide =
            u0 ? FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtP) : FullMath.mulDiv(liquidity, sqrtP, FixedPoint96.Q96);
        spent = fund;
        uint256 cap = (usdcSide * BUYBACK_CHUNK_BPS) / BPS;
        if (spent > cap) spent = cap;
        if (spent == 0) revert NothingToBuyBack();

        // Tokens at the current price, less the 1% fee and 2% room for movement.
        uint256 atPrice = u0
            ? FullMath.mulDiv(FullMath.mulDiv(spent, sqrtP, FixedPoint96.Q96), sqrtP, FixedPoint96.Q96)
            : FullMath.mulDiv(FullMath.mulDiv(spent, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP);
        uint256 minOut = (atPrice * 97) / 100;

        buybackFunds[token] = fund - spent;
        uint256 before = usdc.balanceOf(address(this));
        usdc.forceApprove(address(router), spent);
        burned = router.buy(token, spent, minOut, DEAD, block.timestamp);
        usdc.forceApprove(address(router), 0);
        // The router pulls only what it spends; anything unspent goes back in the fund.
        uint256 used = before - usdc.balanceOf(address(this));
        if (used < spent) buybackFunds[token] += spent - used;
        _usdcHeld -= used;
        emit BuybackDone(token, used, burned);
        spent = used;
    }

    // ------------------------------------------------------------ fees

    /// @notice Collects the locked position's trading fees and splits them between
    /// the creator side (per fee mode) and the protocol. Anyone may call it.
    function collectFees(address token) external nonReentrant returns (uint256 usdcFees, uint256 tokenFees) {
        Position memory p = positions[token];
        if (p.tokenId == 0) revert NotMigrated();
        PoolKey memory key = poolKeyFor(token);

        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(p.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + DEADLINE_WINDOW);
        usdcFees = usdc.balanceOf(address(this)) - usdcBefore;
        tokenFees = IERC20(token).balanceOf(address(this)) - tokenBefore;

        emit FeesCollected(token, usdcFees, tokenFees);

        UsdCurve.FeeMode mode = feeModes[token];
        if (usdcFees > 0) {
            uint256 toCreator = (usdcFees * creatorShareBps) / BPS;
            _payUsdc(protocolFeeRecipient, usdcFees - toCreator);
            if (toCreator > 0) {
                if (mode == UsdCurve.FeeMode.Holders) {
                    emit HolderRewardsSent(token, toCreator);
                    usdc.forceApprove(token, toCreator);
                    UsdToken(token).distribute(toCreator);
                    usdc.forceApprove(token, 0);
                } else if (mode == UsdCurve.FeeMode.Buyback) {
                    buybackFunds[token] += toCreator;
                    _usdcHeld += toCreator;
                    emit BuybackFunded(token, toCreator);
                } else {
                    _payUsdc(p.creator, toCreator);
                }
            }
        }
        if (tokenFees > 0) {
            uint256 toCreator = (tokenFees * creatorShareBps) / BPS;
            // Only creator mode pays coins out; the other modes burn them.
            address creatorSide = mode == UsdCurve.FeeMode.Creator ? p.creator : DEAD;
            if (toCreator > 0) IERC20(token).safeTransfer(creatorSide, toCreator);
            if (tokenFees - toCreator > 0) IERC20(token).safeTransfer(protocolFeeRecipient, tokenFees - toCreator);
        }
    }

    /// @notice Pays out USDC a recipient couldn't receive at collection time.
    function withdrawOwed() external nonReentrant {
        uint256 amount = usdcOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        usdcOwed[msg.sender] = 0;
        _usdcHeld -= amount;
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice The hook's init-code hash for a migrator at `migrator_` (to search a CREATE2 salt off-chain).
    function hookInitCodeHash(address poolManager_, address migrator_) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(poolManager_, migrator_)));
    }

    // ------------------------------------------------------------ internals

    function _approveForMint(address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(permit2), amount);
        permit2.approve(asset, address(positionManager), uint160(amount), uint48(block.timestamp + DEADLINE_WINDOW));
    }

    /// @dev Never lets one recipient (e.g. a blocked address) stop fee collection.
    function _payUsdc(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            usdcOwed[to] += amount;
            _usdcHeld += amount;
            emit UsdcOwed(to, amount);
        }
    }

    /// @dev sqrt(amount1 / amount0) in Q64.96, kept inside the valid range.
    function _sqrtPrice(uint256 amount1, uint256 amount0) private pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint256 s = Math.sqrt(ratioX192);
        if (s < TickMath.MIN_SQRT_PRICE + 1) s = TickMath.MIN_SQRT_PRICE + 1;
        if (s > TickMath.MAX_SQRT_PRICE - 1) s = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
