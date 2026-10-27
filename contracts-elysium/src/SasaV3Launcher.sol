// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "./TickMath.sol";
import {SasaCoin} from "./SasaCoin.sol";

interface IWrappedNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

interface IV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/**
 * sasa launches on Elysium (and any chain with a Uniswap-v3-style DEX).
 *
 * One transaction: the coin is created with a fixed supply, ALL of it goes into a coin/WHYPE pool
 * as one-sided liquidity starting at the configured market cap, the liquidity position stays in this
 * contract forever (nobody, not even the owner, can remove it), and the creator's first buy is made
 * straight against the pool so nobody can buy before them.
 *
 * The pool's swap fee (the v3 fee tier, 1% by default) is the trading fee. Anyone can call
 * collect(): the fees are split between sasa's treasury and the coin's creator (the creator's share
 * is fixed per coin at launch).
 *
 * DEX-agnostic: only the position manager's standard calls and the pool's swap are used, so the same
 * contract works with Uniswap v3 and its forks.
 */
contract SasaV3Launcher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint256 public constant MAX_CREATOR_BPS = 5_000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IV3PositionManager public immutable positions;
    IWrappedNative public immutable wrapped;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    /// Gets sasa's share of pool fees and the launch fee.
    address public treasury;
    /// Starting market cap of a new coin, in native wei (HYPE), for the whole supply.
    uint256 public startMc;
    /// Creator share of pool fees for coins launched from now on, in basis points.
    uint16 public creatorBps;
    /// Paid by the launcher, in native wei, on top of the first buy.
    uint256 public launchFee;
    bool public paused;

    struct Coin {
        uint256 tokenId;
        address pool;
        address creator;
        uint16 creatorBps;
        bool coinIsToken0;
    }

    mapping(address coin => Coin) public coins;
    address[] public allCoins;

    address private swapping; // the pool whose swap callback is expected

    event Launched(
        address indexed coin,
        address indexed creator,
        address pool,
        uint256 tokenId,
        string name,
        string symbol,
        string uri,
        uint256 startMc,
        uint256 firstBuyIn,
        uint256 firstBuyOut
    );
    event FeesCollected(address indexed coin, uint256 coinToCreator, uint256 coinToTreasury, uint256 nativeToCreator, uint256 nativeToTreasury);
    event SettingsChanged(address treasury, uint256 startMc, uint16 creatorBps, uint256 launchFee, bool paused);

    error Paused();
    error BadSettings();
    error FeeNotPaid();
    error TooLittleOut();
    error UnknownCoin();
    error BadCallback();
    error EmptyName();

    constructor(
        address owner_,
        IV3PositionManager positions_,
        IWrappedNative wrapped_,
        uint24 fee_,
        int24 tickSpacing_,
        address treasury_,
        uint256 startMc_,
        uint16 creatorBps_
    ) Ownable(owner_) {
        if (address(positions_) == address(0) || address(wrapped_) == address(0) || tickSpacing_ <= 0) revert BadSettings();
        positions = positions_;
        wrapped = wrapped_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        _set(treasury_, startMc_, creatorBps_, 0, false);
    }

    // ---------------------------------------------------------------- settings

    function setSettings(address treasury_, uint256 startMc_, uint16 creatorBps_, uint256 launchFee_, bool paused_)
        external
        onlyOwner
    {
        _set(treasury_, startMc_, creatorBps_, launchFee_, paused_);
    }

    function _set(address treasury_, uint256 startMc_, uint16 creatorBps_, uint256 launchFee_, bool paused_) private {
        // the price math holds for market caps between 1e9 wei and 1e30 wei of the whole supply
        if (treasury_ == address(0) || creatorBps_ > MAX_CREATOR_BPS || startMc_ < 1e9 || startMc_ > 1e30) {
            revert BadSettings();
        }
        treasury = treasury_;
        startMc = startMc_;
        creatorBps = creatorBps_;
        launchFee = launchFee_;
        paused = paused_;
        emit SettingsChanged(treasury_, startMc_, creatorBps_, launchFee_, paused_);
    }

    function coinCount() external view returns (uint256) {
        return allCoins.length;
    }

    // ---------------------------------------------------------------- launch

    /**
     * Launches a coin for `creator` (msg.sender if zero). msg.value = launchFee + the first buy (may
     * be zero). The first buy's coins go to the creator; `minOut` protects it.
     */
    function launch(string calldata name, string calldata symbol, string calldata uri, address creator, uint256 minOut)
        external
        payable
        nonReentrant
        returns (address coin, uint256 bought)
    {
        if (paused) revert Paused();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (msg.value < launchFee) revert FeeNotPaid();
        if (creator == address(0)) creator = msg.sender;

        coin = address(new SasaCoin(name, symbol, uri, SUPPLY, creator));
        bool coinIsToken0 = coin < address(wrapped);
        (address pool, uint256 tokenId) = _pool(coin, coinIsToken0);
        coins[coin] = Coin(tokenId, pool, creator, creatorBps, coinIsToken0);
        allCoins.push(coin);

        if (launchFee > 0) _sendNative(treasury, launchFee);
        uint256 buyIn = msg.value - launchFee;
        if (buyIn > 0) bought = _buy(coin, pool, coinIsToken0, buyIn, creator);
        if (bought < minOut) revert TooLittleOut();

        emit Launched(coin, creator, pool, tokenId, name, symbol, uri, startMc, buyIn, bought);
    }

    /// Creates the pool at the start price and puts the whole supply into it as one-sided liquidity.
    function _pool(address coin, bool coinIsToken0) private returns (address pool, uint256 tokenId) {
        int24 sp = tickSpacing;
        int24 maxTick = (TickMath.MAX_TICK / sp) * sp;
        int24 minTick = -maxTick;
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtStart;
        if (coinIsToken0) {
            // price = native per coin = startMc / SUPPLY; the coin sits above the start price
            uint256 sqrtP = Math.sqrt(Math.mulDiv(startMc, 1 << 96, SUPPLY)) << 48;
            int24 t = _floor(TickMath.getTickAtSqrtPrice(uint160(sqrtP)), sp);
            tickLower = t;
            tickUpper = maxTick;
            sqrtStart = TickMath.getSqrtPriceAtTick(t);
        } else {
            // price = coins per native = SUPPLY / startMc; the coin sits below the start price
            uint256 sqrtP = Math.sqrt(Math.mulDiv(SUPPLY, 1 << 96, startMc)) << 48;
            int24 t = _floor(TickMath.getTickAtSqrtPrice(uint160(sqrtP)), sp);
            tickLower = minTick;
            tickUpper = t;
            sqrtStart = TickMath.getSqrtPriceAtTick(t);
        }
        (address token0, address token1) = coinIsToken0 ? (coin, address(wrapped)) : (address(wrapped), coin);
        pool = positions.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtStart);

        IERC20(coin).forceApprove(address(positions), SUPPLY);
        (tokenId,,,) = positions.mint(
            IV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: coinIsToken0 ? SUPPLY : 0,
                amount1Desired: coinIsToken0 ? 0 : SUPPLY,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        // rounding dust the pool could not take is burned, never kept
        uint256 left = IERC20(coin).balanceOf(address(this));
        if (left > 0) IERC20(coin).safeTransfer(DEAD, left);
    }

    /// The first buy, straight against the pool (no router), coins to `to`.
    function _buy(address coin, address pool, bool coinIsToken0, uint256 amountIn, address to)
        private
        returns (uint256 out)
    {
        wrapped.deposit{value: amountIn}();
        bool zeroForOne = !coinIsToken0; // paying with the wrapped native token
        swapping = pool;
        (int256 a0, int256 a1) = IV3Pool(pool).swap(
            to,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        swapping = address(0);
        int256 coinDelta = coinIsToken0 ? a0 : a1;
        int256 paid = coinIsToken0 ? a1 : a0;
        out = uint256(-coinDelta);
        // whatever the pool did not take goes back to the buyer, as native
        uint256 rest = amountIn - uint256(paid);
        if (rest > 0) {
            wrapped.withdraw(rest);
            _sendNative(to, rest);
        }
        coin; // silence
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != swapping || swapping == address(0)) revert BadCallback();
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        IERC20(address(wrapped)).safeTransfer(msg.sender, owed);
    }

    // ---------------------------------------------------------------- fees

    /// Collects a coin's pool fees and splits them between its creator and sasa. Anyone can call it.
    function collect(address coin) public nonReentrant returns (uint256 coinAmount, uint256 nativeAmount) {
        Coin memory c = coins[coin];
        if (c.pool == address(0)) revert UnknownCoin();
        (uint256 a0, uint256 a1) = positions.collect(
            IV3PositionManager.CollectParams(c.tokenId, address(this), type(uint128).max, type(uint128).max)
        );
        (coinAmount, nativeAmount) = c.coinIsToken0 ? (a0, a1) : (a1, a0);
        uint256 coinCreator = (coinAmount * c.creatorBps) / 10_000;
        uint256 nativeCreator = (nativeAmount * c.creatorBps) / 10_000;
        if (coinCreator > 0) IERC20(coin).safeTransfer(c.creator, coinCreator);
        if (coinAmount > coinCreator) IERC20(coin).safeTransfer(treasury, coinAmount - coinCreator);
        IERC20 w = IERC20(address(wrapped));
        if (nativeCreator > 0) w.safeTransfer(c.creator, nativeCreator);
        if (nativeAmount > nativeCreator) w.safeTransfer(treasury, nativeAmount - nativeCreator);
        emit FeesCollected(coin, coinCreator, coinAmount - coinCreator, nativeCreator, nativeAmount - nativeCreator);
    }

    function collectMany(address[] calldata list) external {
        for (uint256 i; i < list.length; ++i) collect(list[i]);
    }

    // ---------------------------------------------------------------- helpers

    function _floor(int24 tick, int24 sp) private pure returns (int24) {
        int24 r = tick / sp;
        if (tick < 0 && tick % sp != 0) r--;
        return r * sp;
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            // a contract that can't take native gets the wrapped token instead
            wrapped.deposit{value: amount}();
            IERC20(address(wrapped)).safeTransfer(to, amount);
        }
    }

    /// The position NFTs never leave this contract; accepting them is all this does.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {
        // only the wrapped-native contract sends native here (refund of an unused first buy)
        if (msg.sender != address(wrapped)) revert BadCallback();
    }
}
