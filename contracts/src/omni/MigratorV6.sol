// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

import {NeuronGraduationHook} from "../curve/NeuronGraduationHook.sol";
import {MigratorV6Core, ICoinBurn} from "./MigratorV6Core.sol";
import {IHubLocal} from "./ConsolidatorV6.sol";

/// @notice The pool router (UsdPoolRouter) buybacks go through.
interface IV6BuybackRouter {
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        returns (uint256 tokensOut);
}

/**
 * @title MigratorV6
 * @notice v6 migrator: the graduation rules of MigratorV6Core, plus the Uniswap v4
 * pool steps of the v5 migrator (UsdV4Migrator), unchanged where possible:
 * - 1% fee coin/USDC pool keyed to this migrator's own hook, so nobody can create it
 *   before graduation. Full-range liquidity; the position NFT never leaves this
 *   contract, which cannot remove liquidity: locked forever.
 * - Trading fees can be collected by anyone and are split between the creator side
 *   (paid to the creator, or buyback in buyback mode) and the protocol.
 * - Buybacks spend at most 0.5% of the pool's USDC side per call and burn the coins.
 *
 * Exposes the same views the v5 pool router reads (poolKeyFor, positions, usdc,
 * usdcIsCurrency0), so the existing UsdPoolRouter can trade v6 pools.
 */
contract MigratorV6 is MigratorV6Core {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant DEADLINE_WINDOW = 300;
    uint256 public constant BUYBACK_CHUNK_BPS = 50;
    uint8 internal constant MODE_CREATOR = 0;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    NeuronGraduationHook public immutable hook;
    address public immutable protocolFeeRecipient;
    /// @notice Receives the graduation fee (sasa's treasury).
    address public immutable treasury;
    uint16 public immutable creatorShareBps;
    address private immutable deployer;

    IV6BuybackRouter public router;

    struct Position {
        uint256 tokenId;
        address creator;
    }

    mapping(address token => Position) public positions;
    mapping(address token => bytes32) public coinIdOf;
    mapping(address recipient => uint256) public usdcOwed;
    uint256 public lockedUsdcDust;

    event Migrated(address indexed token, uint256 indexed tokenId, uint256 usdcIn, uint256 tokensIn, uint160 sqrtPriceX96);
    event FeesCollected(address indexed token, uint256 usdcFees, uint256 tokenFees);
    event UsdcOwed(address indexed recipient, uint256 amount);
    event BuybackDone(address indexed token, uint256 usdcSpent, uint256 tokensBurned);

    error ZeroAddress();
    error BadHookAddress(address hook);
    error BadShare();
    error NotMigrated();
    error NothingOwed();
    error NotDeployer();
    error AlreadyBound();
    error NoRouter();
    error NothingToBuyBack();
    error NothingToMigrate();

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        IERC20 usdc_,
        IHubLocal hub_,
        address bridge_,
        address protocolFeeRecipient_,
        address treasury_,
        uint16 creatorShareBps_,
        bytes32 hookSalt
    ) MigratorV6Core(usdc_, hub_, bridge_) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || address(usdc_) == address(0) || protocolFeeRecipient_ == address(0)
                || address(hub_) == address(0) || bridge_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (creatorShareBps_ > BPS) revert BadShare();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        protocolFeeRecipient = protocolFeeRecipient_;
        treasury = treasury_;
        creatorShareBps = creatorShareBps_;
        deployer = msg.sender;
        hook = new NeuronGraduationHook{salt: hookSalt}(address(poolManager_), address(this));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != Hooks.BEFORE_INITIALIZE_FLAG) {
            revert BadHookAddress(address(hook));
        }
    }

    function bindRouter(IV6BuybackRouter router_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(router) != address(0)) revert AlreadyBound();
        if (address(router_) == address(0)) revert ZeroAddress();
        router = router_;
    }

    // ------------------------------------------------------------ pool

    function usdcIsCurrency0(address token) public view returns (bool) {
        return address(usdc) < token;
    }

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

    function _gradFeeTo() internal view override returns (address) {
        return treasury;
    }

    function _openPool(bytes32 coinId, address token, uint256 tokenAmount, uint256 quoteAmount) internal override {
        if (quoteAmount == 0 || tokenAmount == 0) revert NothingToMigrate();
        uint256 usdcBefore = usdc.balanceOf(address(this));

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
        positions[token] = Position({tokenId: tokenId, creator: grads[coinId].creator});
        coinIdOf[token] = coinId;

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
        _held += usdcLeft;
        uint256 tokensLeft = IERC20(token).balanceOf(address(this));
        if (tokensLeft > 0) ICoinBurn(token).burn(tokensLeft);
        IERC20(token).forceApprove(address(permit2), 0);
        usdc.forceApprove(address(permit2), 0);

        emit Migrated(token, tokenId, quoteAmount - usdcLeft, tokenAmount - tokensLeft, sqrtPriceX96);
    }

    // ------------------------------------------------------------ buyback

    /// @notice Spends one chunk (at most 0.5% of the pool's USDC side) of a coin's
    /// buyback money in its pool and burns the coins. Anyone can call it.
    function buyback(address token) external nonReentrant returns (uint256 spent, uint256 burned) {
        if (address(router) == address(0)) revert NoRouter();
        bytes32 id = coinIdOf[token];
        uint256 fund = buybackFunds[id];
        if (fund == 0 || positions[token].tokenId == 0) revert NothingToBuyBack();

        PoolId pid = poolKeyFor(token).toId();
        (uint160 sqrtP,,,) = poolManager.getSlot0(pid);
        uint128 liquidity = poolManager.getLiquidity(pid);
        bool u0 = usdcIsCurrency0(token);
        uint256 usdcSide =
            u0 ? FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtP) : FullMath.mulDiv(liquidity, sqrtP, FixedPoint96.Q96);
        spent = fund;
        uint256 cap = (usdcSide * BUYBACK_CHUNK_BPS) / BPS;
        if (spent > cap) spent = cap;
        if (spent == 0) revert NothingToBuyBack();

        uint256 atPrice = u0
            ? FullMath.mulDiv(FullMath.mulDiv(spent, sqrtP, FixedPoint96.Q96), sqrtP, FixedPoint96.Q96)
            : FullMath.mulDiv(FullMath.mulDiv(spent, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP);
        uint256 minOut = (atPrice * 97) / 100;

        buybackFunds[id] = fund - spent;
        uint256 before = usdc.balanceOf(address(this));
        usdc.forceApprove(address(router), spent);
        burned = router.buy(token, spent, minOut, address(this), block.timestamp);
        usdc.forceApprove(address(router), 0);
        uint256 used = before - usdc.balanceOf(address(this));
        if (used < spent) buybackFunds[id] += spent - used;
        _held -= used;
        ICoinBurn(token).burn(burned);
        emit BuybackDone(token, used, burned);
        spent = used;
    }

    // ------------------------------------------------------------ fees

    function collectFees(address token) external nonReentrant returns (uint256 usdcFees, uint256 tokenFees) {
        Position memory p = positions[token];
        if (p.tokenId == 0) revert NotMigrated();
        PoolKey memory key = poolKeyFor(token);
        bytes32 id = coinIdOf[token];

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

        bool creatorMode = grads[id].feeMode == MODE_CREATOR;
        if (usdcFees > 0) {
            uint256 toCreator = (usdcFees * creatorShareBps) / BPS;
            _payUsdc(protocolFeeRecipient, usdcFees - toCreator);
            if (toCreator > 0) {
                if (creatorMode) {
                    _payUsdc(p.creator, toCreator);
                } else {
                    buybackFunds[id] += toCreator;
                    _held += toCreator;
                    emit BuybackFunded(id, toCreator);
                }
            }
        }
        if (tokenFees > 0) {
            uint256 toCreator = (tokenFees * creatorShareBps) / BPS;
            if (toCreator > 0) {
                if (creatorMode) IERC20(token).safeTransfer(p.creator, toCreator);
                else ICoinBurn(token).burn(toCreator);
            }
            if (tokenFees - toCreator > 0) IERC20(token).safeTransfer(protocolFeeRecipient, tokenFees - toCreator);
        }
    }

    function withdrawOwed() external nonReentrant {
        uint256 amount = usdcOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        usdcOwed[msg.sender] = 0;
        _held -= amount;
        usdc.safeTransfer(msg.sender, amount);
    }

    function hookInitCodeHash(address poolManager_, address migrator_) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(poolManager_, migrator_)));
    }

    // ------------------------------------------------------------ internals

    function _approveForMint(address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(permit2), amount);
        permit2.approve(asset, address(positionManager), uint160(amount), uint48(block.timestamp + DEADLINE_WINDOW));
    }

    function _payUsdc(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            usdcOwed[to] += amount;
            _held += amount;
            emit UsdcOwed(to, amount);
        }
    }

    function _sqrtPrice(uint256 amount1, uint256 amount0) private pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint256 s = Math.sqrt(ratioX192);
        if (s < TickMath.MIN_SQRT_PRICE + 1) s = TickMath.MIN_SQRT_PRICE + 1;
        if (s > TickMath.MAX_SQRT_PRICE - 1) s = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
