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
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {IGraduationMigrator, NeuronCurve} from "./NeuronCurve.sol";
import {NeuronGraduationHook} from "./NeuronGraduationHook.sol";

interface ICurveRegistry {
    function isCurve(address curve) external view returns (bool);
}

/**
 * @title NeuronV4Migrator
 * @notice Turns a graduating curve into a Uniswap v4 pool with full-range
 * liquidity that is locked forever.
 *
 * - Only curves created by the paired factory can call `migrate`, once per
 *   coin.
 * - The pool is native coin / token, 1% fee, keyed to this migrator's own
 *   hook, so nobody can create it before graduation.
 * - The opening price is the curve's last price.
 * - The position NFT is minted to this contract, which has no way to move
 *   it or remove liquidity: the liquidity can never be pulled.
 * - Trading fees earned by the position can be collected by anyone and are
 *   split between the coin's creator and the protocol.
 *
 * Rounding dust that does not fit the position stays in this contract
 * (native) or is burned (tokens).
 */
contract NeuronV4Migrator is IGraduationMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant DEADLINE_WINDOW = 300;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    /// @notice The curve factory whose curves may graduate here. Bound once,
    /// right after deployment (the factory needs this migrator's address).
    ICurveRegistry public curves;
    address private immutable deployer;
    NeuronGraduationHook public immutable hook;
    address public immutable protocolFeeRecipient;
    uint16 public immutable creatorShareBps;

    struct Position {
        uint256 tokenId;
        address creator;
    }

    mapping(address token => Position) public positions;
    /// @notice Native fees that could not be pushed (the recipient refused them).
    mapping(address recipient => uint256) public nativeOwed;

    /// @dev Native coin this contract holds as locked rounding dust.
    uint256 public lockedNativeDust;

    event Migrated(address indexed token, uint256 indexed tokenId, uint256 nativeIn, uint256 tokensIn, uint160 sqrtPriceX96);
    event FeesCollected(address indexed token, uint256 nativeFees, uint256 tokenFees);
    event NativeOwed(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NotACurve();
    error WrongToken();
    error AlreadyMigrated();
    error NothingToMigrate();
    error BadHookAddress(address hook);
    error BadShare();
    error NotMigrated();
    error NothingOwed();
    error TransferFailed();
    error NotDeployer();
    error AlreadyBound();

    /**
     * @param hookSalt CREATE2 salt that gives the hook an address carrying
     * exactly the before-initialize flag (find it with `hookAddressFor`).
     */
    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        address protocolFeeRecipient_,
        uint16 creatorShareBps_,
        bytes32 hookSalt
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || protocolFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (creatorShareBps_ > BPS) revert BadShare();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        deployer = msg.sender;
        protocolFeeRecipient = protocolFeeRecipient_;
        creatorShareBps = creatorShareBps_;
        hook = new NeuronGraduationHook{salt: hookSalt}(address(poolManager_), address(this));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != Hooks.BEFORE_INITIALIZE_FLAG) {
            revert BadHookAddress(address(hook));
        }
    }

    /// @notice One-time link to the curve factory. Until then nothing can graduate.
    function bindCurves(ICurveRegistry curves_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(curves) != address(0)) revert AlreadyBound();
        if (address(curves_) == address(0)) revert ZeroAddress();
        curves = curves_;
    }

    /// @dev Native fees and sweeps come back here.
    receive() external payable {}

    /// @notice The pool a graduated `token` trades in.
    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// @inheritdoc IGraduationMigrator
    function migrate(address token, uint256 tokenAmount) external payable nonReentrant {
        if (address(curves) == address(0) || !curves.isCurve(msg.sender)) revert NotACurve();
        if (address(NeuronCurve(payable(msg.sender)).token()) != token) revert WrongToken();
        if (positions[token].tokenId != 0) revert AlreadyMigrated();
        uint256 nativeAmount = msg.value;
        if (nativeAmount == 0 || tokenAmount == 0) revert NothingToMigrate();

        PoolKey memory key = poolKeyFor(token);

        // Price = tokens per native coin (currency1 / currency0).
        uint160 sqrtPriceX96 = _sqrtPrice(tokenAmount, nativeAmount);
        poolManager.initialize(key, sqrtPriceX96);

        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        int24 tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            nativeAmount,
            tokenAmount
        );
        if (liquidity == 0) revert NothingToMigrate();

        IERC20(token).forceApprove(address(permit2), tokenAmount);
        permit2.approve(token, address(positionManager), uint160(tokenAmount), uint48(block.timestamp + DEADLINE_WINDOW));

        uint256 tokenId = positionManager.nextTokenId();
        positions[token] = Position({tokenId: tokenId, creator: NeuronCurve(payable(msg.sender)).creator()});

        uint256 nativeBefore = address(this).balance - nativeAmount;
        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(nativeAmount), uint128(tokenAmount), address(this), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        positionManager.modifyLiquidities{value: nativeAmount}(
            abi.encode(actions, params), block.timestamp + DEADLINE_WINDOW
        );

        // Whatever did not fit the position: native stays here, locked;
        // tokens are burned.
        uint256 nativeLeft = address(this).balance - nativeBefore;
        lockedNativeDust += nativeLeft;
        uint256 tokensLeft = IERC20(token).balanceOf(address(this));
        if (tokensLeft > 0) IERC20(token).safeTransfer(DEAD, tokensLeft);
        IERC20(token).forceApprove(address(permit2), 0);

        emit Migrated(token, tokenId, nativeAmount - nativeLeft, tokenAmount - tokensLeft, sqrtPriceX96);
    }

    /**
     * @notice Collects the trading fees the locked position has earned and
     * splits them between the coin's creator and the protocol. Anyone may
     * call it; the money only goes to those two.
     */
    function collectFees(address token) external nonReentrant returns (uint256 nativeFees, uint256 tokenFees) {
        Position memory p = positions[token];
        if (p.tokenId == 0) revert NotMigrated();
        PoolKey memory key = poolKeyFor(token);

        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        // A zero-liquidity decrease settles the owed fees; TAKE_PAIR pays them here.
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(p.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + DEADLINE_WINDOW);
        nativeFees = address(this).balance - nativeBefore;
        tokenFees = IERC20(token).balanceOf(address(this)) - tokenBefore;

        emit FeesCollected(token, nativeFees, tokenFees);

        if (nativeFees > 0) {
            uint256 toCreator = (nativeFees * creatorShareBps) / BPS;
            _payNative(p.creator, toCreator);
            _payNative(protocolFeeRecipient, nativeFees - toCreator);
        }
        if (tokenFees > 0) {
            uint256 toCreator = (tokenFees * creatorShareBps) / BPS;
            if (toCreator > 0) IERC20(token).safeTransfer(p.creator, toCreator);
            if (tokenFees - toCreator > 0) IERC20(token).safeTransfer(protocolFeeRecipient, tokenFees - toCreator);
        }
    }

    /// @notice Pays out native fees a recipient refused at collection time.
    function withdrawOwed() external nonReentrant {
        uint256 amount = nativeOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        nativeOwed[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice The hook's init-code hash for a migrator at `migrator_`; with it,
    /// a CREATE2 salt giving the right hook address can be searched off-chain.
    function hookInitCodeHash(address poolManager_, address migrator_) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(poolManager_, migrator_)));
    }

    function _payNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) {
            nativeOwed[to] += amount;
            emit NativeOwed(to, amount);
        }
    }

    /// @dev sqrt(tokens / native) in Q64.96, kept inside the valid range.
    function _sqrtPrice(uint256 tokenAmount, uint256 nativeAmount) private pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(tokenAmount, 1 << 192, nativeAmount);
        uint256 s = Math.sqrt(ratioX192);
        if (s < TickMath.MIN_SQRT_PRICE + 1) s = TickMath.MIN_SQRT_PRICE + 1;
        if (s > TickMath.MAX_SQRT_PRICE - 1) s = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
