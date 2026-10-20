// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {LPFeeLibrary} from "infinity-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {SqrtPriceMath} from "infinity-core/src/pool-cl/libraries/SqrtPriceMath.sol";
import {FixedPoint96} from "infinity-core/src/pool-cl/libraries/FixedPoint96.sol";

import {RaceLaunchHookPcs} from "./RaceLaunchHookPcs.sol";

interface IRaceHubKeeperPcs {
    function keeper() external view returns (address);
}

interface IRaceFactoryHubPcs {
    function hub() external view returns (address);
}

interface IRaceCoinPcs is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function openBridge(uint32 winnerEid) external;
}

/// @notice Chainlink-style price feed (BNB/USD on BNB Chain).
interface IPriceFeedPcs {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IRaceSeatBook {
    function bookHandOver(uint256 handed) external;
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @notice The few calls of a PancakeSwap v3 pool used for the USDC <-> BNB leg.
interface IPancakeV3PoolMin {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/**
 * @title RaceBuilderPcs (sasa v7, native pairs): a coin's BNB pool on BNB Chain
 * @notice The same race as RaceBuilderEth, on PancakeSwap Infinity (the CL pools of BNB
 * Chain's main DEX, the ones DexScreener, GMGN and trading bots read). Each coin's pool is
 * coin/BNB (native BNB). Everything that enters or leaves this contract from the rest of sasa
 * is still dollars (USDC), so the factory, seat, hub, consolidator and dollar bridges are the
 * same reviewed contracts.
 *  1. launch: the pool opens at the dollar launch price turned into BNB with the Chainlink
 *     BNB/USD price; the creator's first buy arrives in USDC: USDC -> BNB (the chain's deep
 *     PancakeSwap v3 USDC/WBNB pool, at least 98% of the Chainlink value) -> coin;
 *  2. race report: the BNB in the pool, valued with Chainlink, in 6-decimal dollars;
 *  3. losing chain: all liquidity out once, unsold coins burned, pool closed, the BNB swapped
 *     to USDC (at least 98% of its Chainlink value) and handed over; if the price isn't fair
 *     right then, the verdict still goes through and the BNB waits for `convertLost`;
 *  4. winning chain: arriving USDC is swapped to BNB (at least 98%) and added above the price
 *     as BNB-only liquidity: the pool gets deeper, no coin minted.
 * The positions are held by this contract directly in PancakeSwap's pool manager (no NFT):
 * they can't be moved or sold; the only removal is the losing-chain hand-over, once.
 */
contract RaceBuilderPcs is ILockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    int24 public constant TICK_SPACING = 200;
    uint256 public constant BPS = 10_000;
    uint256 public constant CREATOR_SIDE_BPS = 3_000;
    uint256 public constant GRAD_FEE_BPS = 200;
    uint256 public constant MAX_SLIP_BPS = 200;
    uint256 public constant RACE_SECONDS = 300;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant BUYBACK_CHUNK = 0.1 ether; // BNB
    uint256 public constant MAX_EXTRA_POSITIONS = 50;
    uint8 public constant REPORT_DECIMALS = 6;
    uint16 internal constant HOOKS_BITMAP = uint16(1 << 0) | uint16(1 << 6); // = RaceLaunchHookPcs.HOOKS_BITMAP
    Currency internal constant BNB = Currency.wrap(address(0));
    uint160 internal constant V3_MIN_SQRT = 4295128739 + 1;
    uint160 internal constant V3_MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    enum State {
        None,
        Racing,
        Won,
        Lost
    }

    /// @notice The race result written down at the end of the five minutes (see recordRaceEnd).
    struct RaceEnd {
        uint256 money; // BNB in the launch position when the race ended
        uint256 coinsInPool; // coins in the launch position when the race ended
        bool recorded;
        int24 tick; // the pool's price when the race ended: arriving money is never placed above it
    }

    struct Race {
        address seat;
        address creator;
        uint8 feeMode; // 0 = fees to the creator, 1 = buyback & burn
        uint64 launchedAt;
        State state;
        uint32 winnerEid;
        int24 launchLower;
        int24 launchUpper;
    }

    struct Range {
        int24 lower;
        int24 upper;
    }

    enum Act {
        Mint, // add a position (pays BNB or coins)
        Collect, // all positions: fees out
        Unwind, // all positions: all liquidity out (losing chain, once)
        Buy, // BNB -> coin
        BuyCapped // BNB -> coin, stopping at a price limit (v8 merge)
    }

    IVault public immutable vault;
    ICLPoolManager public immutable poolManager;
    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;
    IWrappedNative public immutable wbnb;
    IPancakeV3PoolMin public immutable dollarPool;
    bool internal immutable usdcIsToken0;
    address public immutable treasury;
    RaceLaunchHookPcs public immutable hook;
    IPriceFeedPcs public immutable bnbUsd;
    uint8 internal immutable feedDecimals;
    uint256 public immutable maxFeedAge;
    address private immutable _deployer;

    address public factory;
    address public consolidator;
    address public bridge;

    mapping(address coin => Race) public races;
    mapping(bytes32 coinId => address coin) public coinOf;
    mapping(address coin => uint256) public lostPending; // BNB of a losing pool waiting to be handed over
    mapping(address coin => Range[]) internal _extra; // salt of extra position i = i + 1
    mapping(address coin => uint256) public buybackFunds; // in BNB
    mapping(address coin => RaceEnd) public raceEnd;
    mapping(address coin => uint256) public pendingDollars;
    mapping(address who => uint256) public heldFor; // BNB that could not be paid out
    uint256 public bnbReserved; // buyback BNB + held BNB + losing hand-overs waiting
    uint256 public dollarsReserved; // pending USDC
    bool private _inLock;
    bool private _inV3;

    event Bound(address factory, address consolidator, address bridge);
    event PoolOpened(address indexed coin, uint256 coinsIn, uint160 sqrtPriceX96, uint256 startMcBnb);
    event RaceReported(address indexed coin, uint256 poolBnb, uint256 dollars);
    event RaceWon(address indexed coin, uint32 winnerEid);
    event RaceLost(address indexed coin, uint32 winnerEid, uint256 bnbOut, uint256 coinsBurned);
    event HandOverPending(address indexed coin, uint256 bnbAmount);
    event HandedOver(address indexed coin, uint256 bnbIn, uint256 usdcOut, uint256 gradFee);
    event Deepened(address indexed coin, uint256 indexed index, uint256 bnbIn);
    /// @notice v8: part of the money that arrived from the losing chains bought coins in the pool.
    event MergeBuy(address indexed coin, uint256 bnbSpent, uint256 coinsBought);
    event ArrivalPending(address indexed coin, uint256 usdcAmount);
    event FeesCollected(address indexed coin, uint256 bnbFees, uint256 coinFees);
    event BuybackFunded(address indexed coin, uint256 amount);
    event BuybackDone(address indexed coin, uint256 bnbSpent, uint256 coinsBurned);
    event HeldFor(address indexed who, uint256 amount);

    error ZeroAddress();
    error NotDeployer();
    error AlreadyBound();
    error NotFactory();
    error NotSeat();
    error NotBridge();
    error AlreadyOpen();
    error NotOpen();
    error RaceNotOver();
    error RaceDone();
    error NothingToDo();
    error NotDelivered();
    error BadDollarPool();
    error BadPrice();
    error OnlyVault();
    error NotOurCall();
    error NotSelf();
    error Slippage(uint256 got, uint256 minimum);
    error NotKeeper();

    constructor(
        IVault vault_,
        ICLPoolManager poolManager_,
        IERC20 usdc_,
        IWrappedNative wbnb_,
        IPancakeV3PoolMin dollarPool_,
        address treasury_,
        IPriceFeedPcs bnbUsd_,
        uint256 maxFeedAge_
    ) {
        if (
            address(vault_) == address(0) || address(poolManager_) == address(0) || address(usdc_) == address(0)
                || address(wbnb_) == address(0) || address(dollarPool_) == address(0) || treasury_ == address(0)
                || address(bnbUsd_) == address(0) || maxFeedAge_ == 0
        ) revert ZeroAddress();
        address t0 = dollarPool_.token0();
        address t1 = dollarPool_.token1();
        if (!((t0 == address(usdc_) && t1 == address(wbnb_)) || (t0 == address(wbnb_) && t1 == address(usdc_)))) {
            revert BadDollarPool();
        }
        vault = vault_;
        poolManager = poolManager_;
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        wbnb = wbnb_;
        dollarPool = dollarPool_;
        usdcIsToken0 = t0 == address(usdc_);
        treasury = treasury_;
        bnbUsd = bnbUsd_;
        feedDecimals = bnbUsd_.decimals();
        maxFeedAge = maxFeedAge_;
        _deployer = msg.sender;
        hook = new RaceLaunchHookPcs(address(poolManager_), address(this));
    }

    /// @dev BNB only comes in from PancakeSwap's vault (swaps, liquidity, fees) and WBNB.
    receive() external payable {
        if (msg.sender != address(vault) && msg.sender != address(wbnb)) revert NotOurCall();
    }

    function bind(address factory_, address consolidator_, address bridge_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0) || consolidator_ == address(0) || bridge_ == address(0)) revert ZeroAddress();
        factory = factory_;
        consolidator = consolidator_;
        bridge = bridge_;
        emit Bound(factory_, consolidator_, bridge_);
    }

    // ------------------------------------------------------------------ views

    /// @notice The coin's pool: native BNB (always currency0) / coin, PancakeSwap Infinity CL.
    function poolKeyFor(address coin) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: BNB,
            currency1: Currency.wrap(coin),
            hooks: IHooks(address(hook)),
            poolManager: IPoolManager(address(poolManager)),
            fee: POOL_FEE,
            parameters: bytes32((uint256(uint24(TICK_SPACING)) << 16) | uint256(HOOKS_BITMAP))
        });
    }

    function poolIdFor(address coin) public view returns (PoolId) {
        return poolKeyFor(coin).toId();
    }

    function hub() public view returns (address) {
        return factory == address(0) ? address(0) : IRaceFactoryHubPcs(factory).hub();
    }

    /// @notice Same shape as the other builders: (1, creator) while the pool is alive.
    function positions(address coin) external view returns (uint256 tokenId, address creator) {
        Race storage r = races[coin];
        if (r.state == State.Racing || r.state == State.Won) return (1, r.creator);
        return (0, r.creator);
    }

    function extraPositions(address coin) external view returns (Range[] memory) {
        return _extra[coin];
    }

    /// @notice BNB and coins in the coin's launch position right now (fees excluded).
    function poolAmounts(address coin) public view returns (uint256 bnbAmount, uint256 coinAmount) {
        Race storage r = races[coin];
        if (r.state == State.None) return (0, 0);
        PoolId id = poolIdFor(coin);
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        uint128 liq = poolManager.getLiquidity(id, address(this), r.launchLower, r.launchUpper, bytes32(0));
        return _amounts(r.launchLower, r.launchUpper, liq, sqrtP);
    }

    function raceOver(address coin) public view returns (bool) {
        Race storage r = races[coin];
        return r.launchedAt != 0 && block.timestamp >= uint256(r.launchedAt) + RACE_SECONDS;
    }

    /// @notice Chainlink BNB/USD with `feedDecimals` decimals. Reverts when stale.
    function bnbPrice() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = bnbUsd.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxFeedAge) revert BadPrice();
        return uint256(answer);
    }

    function bnbToUsdc(uint256 weiAmount) public view returns (uint256) {
        return Math.mulDiv(weiAmount, bnbPrice() * 10 ** usdcDecimals, 10 ** (18 + uint256(feedDecimals)));
    }

    function usdcToBnb(uint256 usdcAmount) public view returns (uint256) {
        return Math.mulDiv(usdcAmount, 10 ** (18 + uint256(feedDecimals)), bnbPrice() * 10 ** usdcDecimals);
    }

    // ------------------------------------------------------------------ launch (factory)

    function open(bytes32 coinId, address coin, address seat, uint256 share, uint256 startMarketCap, address creator, uint8 feeMode)
        external
        nonReentrant
    {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        Race storage r = races[coin];
        if (r.state != State.None || coinOf[coinId] != address(0)) revert AlreadyOpen();
        coinOf[coinId] = coin;
        if (share == 0 || share > MAX_SUPPLY || startMarketCap == 0 || seat == address(0) || creator == address(0)) revert NothingToDo();
        uint256 startMcBnb = Math.mulDiv(startMarketCap, 10 ** (18 + uint256(feedDecimals)), bnbPrice() * 10 ** REPORT_DECIMALS);
        if (startMcBnb == 0) revert NothingToDo();

        IRaceCoinPcs(coin).mint(address(this), share);

        PoolKey memory key = poolKeyFor(coin);
        // BNB = currency0: the coin-only position sits entirely below the launch tick
        int24 upper = _tickFloor(TickMath.getTickAtSqrtRatio(_ratioToSqrtX96(startMcBnb, MAX_SUPPLY)));
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        uint160 startSqrtPrice = TickMath.getSqrtRatioAtTick(upper);
        uint128 liquidity = _liquidityForAmount1(TickMath.getSqrtRatioAtTick(lower), startSqrtPrice, share);
        if (liquidity == 0) revert NothingToDo();
        poolManager.initialize(key, startSqrtPrice);

        r.launchLower = lower;
        r.launchUpper = upper;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        _lock(abi.encode(Act.Mint, coin, abi.encode(lower, upper, liquidity, bytes32(0))));
        uint256 coinUsed = coinBefore - IERC20(coin).balanceOf(address(this));
        if (share > coinUsed) IRaceCoinPcs(coin).burn(share - coinUsed);

        r.seat = seat;
        r.creator = creator;
        r.feeMode = feeMode;
        r.launchedAt = uint64(block.timestamp);
        r.state = State.Racing;
        emit PoolOpened(coin, coinUsed, startSqrtPrice, startMcBnb);
    }

    /// @notice The creator's first buy: `usdcAmount` USDC (already sent here by the factory)
    /// is swapped USDC -> BNB -> coin, coins to `to`.
    function launchBuy(address coin, uint256 usdcAmount, uint256 minCoinsOut, address to)
        external
        nonReentrant
        returns (uint256 coinsOut)
    {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        if (races[coin].state != State.Racing) revert NotOpen();
        if (usdcAmount == 0) revert NothingToDo();
        if (usdc.balanceOf(address(this)) < dollarsReserved + usdcAmount) revert NotDelivered();
        uint256 minBnb = (usdcToBnb(usdcAmount) * (BPS - MAX_SLIP_BPS)) / BPS;
        uint256 bnb = _usdcToBnb(usdcAmount, minBnb);
        coinsOut = _buy(coin, bnb, to);
        if (coinsOut < minCoinsOut) revert Slippage(coinsOut, minCoinsOut);
    }

    // ------------------------------------------------------------------ the race (seat -> here)

    modifier onlySeat(address coin) {
        if (msg.sender != races[coin].seat || msg.sender == address(0)) revert NotSeat();
        _;
    }

    /**
     * @notice Called by the hook before the first swap after the five minutes: writes down
     * the BNB (and coins) in the pool as the race ended, before that swap moves anything.
     * Returns true once written (or when the race is decided), false while it is still on.
     * Never reverts for a race pool: a revert here would stop the swap. Anyone may call it too
     * (sasa's keeper does, right at the end, so no trader's swap pays for writing it): until it
     * is written, every swap writes it first, so the pool is still exactly as the race ended.
     * The key only names the coin; the builder reads its own pool. (The dollar value is
     * worked out at report time with Chainlink, as before.)
     */
    function recordRaceEnd(PoolKey calldata key) external returns (bool) {
        address coin = Currency.unwrap(key.currency1); // BNB is always currency0
        Race storage r = races[coin];
        RaceEnd storage e = raceEnd[coin];
        if (r.state != State.Racing || e.recorded) return true;
        if (!raceOver(coin)) return false;
        _writeRaceEnd(coin);
        return true;
    }

    function _writeRaceEnd(address coin) private {
        RaceEnd storage e = raceEnd[coin];
        (e.money, e.coinsInPool) = poolAmounts(coin);
        (, e.tick,,) = poolManager.getSlot0(poolIdFor(coin));
        e.recorded = true;
    }

    /// @notice Race report: the BNB in this chain's pool when the five minutes ended (written
    /// down before any later swap), in 6-decimal dollars at the Chainlink price.
    function report(address coin) external onlySeat(coin) returns (uint256 money, uint256 coinsOutside) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        if (!raceOver(coin)) revert RaceNotOver();
        RaceEnd storage e = raceEnd[coin];
        if (!e.recorded) _writeRaceEnd(coin); // no swap since the end: the pool is still as it ended
        (uint256 bnb, uint256 inPool) = (e.money, e.coinsInPool);
        money = Math.mulDiv(bnb, bnbPrice() * 10 ** REPORT_DECIMALS, 10 ** (18 + uint256(feedDecimals)));
        uint256 supply = IERC20(coin).totalSupply();
        coinsOutside = supply > inPool ? supply - inPool : 0;
        emit RaceReported(coin, bnb, money);
    }

    function settle(address coin, uint32 winnerEid, bool isWinner) external onlySeat(coin) nonReentrant returns (uint256 handedOver) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        r.winnerEid = winnerEid;
        if (isWinner) {
            r.state = State.Won;
            IRaceCoinPcs(coin).openBridge(winnerEid);
            emit RaceWon(coin, winnerEid);
            return 0;
        }
        r.state = State.Lost;
        _collect(coin);

        uint256 bnbBefore = address(this).balance;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        _lock(abi.encode(Act.Unwind, coin, bytes("")));
        uint256 bnbOut = address(this).balance - bnbBefore;
        uint256 coinsOut = IERC20(coin).balanceOf(address(this)) - coinBefore;
        hook.shutPool(poolKeyFor(coin));
        if (coinsOut > 0) IRaceCoinPcs(coin).burn(coinsOut);
        IRaceCoinPcs(coin).openBridge(winnerEid);

        // the pool's BNB and any buyback BNB wait here as the coin's hand-over, then are swapped
        // to USDC right away if the dollar pool gives a fair price (at least 98% of Chainlink);
        // otherwise the verdict still goes through and anyone finishes it with `convertLost`
        uint256 bb = buybackFunds[coin];
        buybackFunds[coin] = 0;
        uint256 bnbTotal = bnbOut + bb;
        lostPending[coin] += bnbTotal;
        bnbReserved += bnbOut; // `bb` was reserved already
        emit RaceLost(coin, winnerEid, bnbTotal, coinsOut);
        if (bnbTotal > 0) {
            try this.handOver(coin, bnbTotal) returns (uint256 handed) {
                handedOver = handed; // the seat books it at the consolidator
            } catch {
                emit HandOverPending(coin, bnbTotal);
            }
        }
    }

    /// @notice Finishes (part of) a losing chain's hand-over that waited for a fair price:
    /// `amount` BNB (0 = all that waits) -> USDC at least 98% of Chainlink -> consolidator.
    /// Anyone may call it; smaller parts move the dollar pool less.
    function convertLost(address coin, uint256 amount) external nonReentrant returns (uint256 handed) {
        if (races[coin].state != State.Lost) revert NotOpen();
        uint256 waiting = lostPending[coin];
        if (amount == 0 || amount > waiting) amount = waiting;
        if (amount == 0) revert NothingToDo();
        handed = _handOver(coin, amount);
        IRaceSeatBook(races[coin].seat).bookHandOver(handed);
    }

    /// @dev Only via `settle` (an external self-call, so a refused swap rolls back alone).
    function handOver(address coin, uint256 amount) external returns (uint256) {
        if (msg.sender != address(this)) revert NotSelf();
        return _handOver(coin, amount);
    }

    function _handOver(address coin, uint256 amount) private returns (uint256 handed) {
        lostPending[coin] -= amount;
        bnbReserved -= amount;
        uint256 minUsdc = (bnbToUsdc(amount) * (BPS - MAX_SLIP_BPS)) / BPS;
        uint256 usdcOut = _bnbToUsdc(amount, minUsdc);
        uint256 gradFee = (usdcOut * GRAD_FEE_BPS) / BPS;
        if (gradFee > 0) usdc.safeTransfer(treasury, gradFee);
        handed = usdcOut - gradFee;
        if (handed > 0) usdc.safeTransfer(consolidator, handed);
        emit HandedOver(coin, amount, usdcOut, gradFee);
    }

    // ------------------------------------------------------------------ arrivals (winning chain)

    function receiveConsolidated(bytes32 coinId, uint256 amount, bool toBuyback) external nonReentrant {
        if (msg.sender != bridge || bridge == address(0)) revert NotBridge();
        address coin = coinOf[coinId];
        Race storage r = races[coin];
        if (r.state == State.None || r.state == State.Lost) revert NotOpen();
        if (amount == 0) revert NothingToDo();
        if (usdc.balanceOf(address(this)) < dollarsReserved + amount) revert NotDelivered();
        dollarsReserved += amount;
        pendingDollars[coin] += amount;
        _tryPlace(coin, toBuyback);
    }

    function convertPending(address coin) external nonReentrant {
        Race storage r = races[coin];
        if (r.state != State.Won && r.state != State.Racing) revert NotOpen();
        if (pendingDollars[coin] == 0) revert NothingToDo();
        if (!_tryPlace(coin, false)) revert BadPrice();
    }

    function _tryPlace(address coin, bool toBuyback) internal returns (bool) {
        uint256 amount = pendingDollars[coin];
        try this.placeArrived(coin, amount, toBuyback) {
            return true;
        } catch {
            emit ArrivalPending(coin, amount);
            return false;
        }
    }

    /// @dev Only via `_tryPlace` (an external self-call, so a failed swap rolls back alone).
    function placeArrived(address coin, uint256 amount, bool toBuyback) external {
        if (msg.sender != address(this)) revert NotSelf();
        pendingDollars[coin] -= amount;
        dollarsReserved -= amount;
        uint256 minBnb = (usdcToBnb(amount) * (BPS - MAX_SLIP_BPS)) / BPS;
        uint256 bnb = _usdcToBnb(amount, minBnb);
        if (toBuyback || !_merge(coin, bnb)) {
            buybackFunds[coin] += bnb;
            bnbReserved += bnb;
            emit BuybackFunded(coin, bnb);
        }
    }

    /// @notice v8: how far the coin may have risen since the race ended before arriving money
    /// stops buying it (20%), and how far the merge buy itself may push the price (2x).
    int24 public constant MERGE_MAX_RISE_TICKS = 1823; // ~ +20%
    int24 public constant MERGE_CAP_TICKS = 6932; // ~ x2

    /**
     * @notice v8 merge (same as the ETH builder): half of the arriving BNB buys the coin in
     * its pool (price up, a green candle), then the coins bought and the other half go in as
     * one full-range position at the new price, where every screener counts liquidity.
     * Nothing minted; leftover BNB funds buybacks, leftover coins are burned. Returns false
     * (the money funds buybacks instead) if the coin is already >20% above its
     * race-end price, so nobody can pump it just before the money lands.
     */
    function _merge(address coin, uint256 amount) internal returns (bool) {
        Range[] storage extra = _extra[coin];
        if (amount < 2 || extra.length >= MAX_EXTRA_POSITIONS) return false;
        RaceEnd storage e = raceEnd[coin];
        if (!e.recorded) return false;
        (, int24 tick,,) = poolManager.getSlot0(poolIdFor(coin));
        // BNB = currency0: the coin gets dearer as the tick FALLS
        if (tick < e.tick - MERGE_MAX_RISE_TICKS) return false;
        int24 capTick = e.tick - MERGE_CAP_TICKS;
        if (capTick < TickMath.MIN_TICK + 1) capTick = TickMath.MIN_TICK + 1;

        uint256 half = amount / 2;
        uint256 bnbBefore = address(this).balance;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        _lock(abi.encode(Act.BuyCapped, coin, abi.encode(half, address(this), TickMath.getSqrtRatioAtTick(capTick))));
        uint256 spent = bnbBefore - address(this).balance;
        uint256 coins = IERC20(coin).balanceOf(address(this)) - coinBefore;
        emit MergeBuy(coin, spent, coins);

        uint256 bnbLeft = amount - spent;
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolIdFor(coin));
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        uint128 l0 = _liquidityForAmount0(sqrtP, sb, bnbLeft);
        uint128 l1 = _liquidityForAmount1(sa, sqrtP, coins);
        uint128 liquidity = l0 < l1 ? l0 : l1;
        uint256 bnbUsed;
        uint256 coinsUsed;
        if (liquidity > 0) {
            uint256 index = extra.length;
            extra.push(Range(lower, upper));
            uint256 bb = address(this).balance;
            uint256 cb = IERC20(coin).balanceOf(address(this));
            _lock(abi.encode(Act.Mint, coin, abi.encode(lower, upper, liquidity, bytes32(index + 1))));
            bnbUsed = bb - address(this).balance;
            coinsUsed = cb - IERC20(coin).balanceOf(address(this));
            emit Deepened(coin, index, spent + bnbUsed);
        }
        if (bnbLeft > bnbUsed) {
            buybackFunds[coin] += bnbLeft - bnbUsed;
            bnbReserved += bnbLeft - bnbUsed;
            emit BuybackFunded(coin, bnbLeft - bnbUsed);
        }
        if (coins > coinsUsed) IRaceCoinPcs(coin).burn(coins - coinsUsed);
        return true;
    }


    // ------------------------------------------------------------------ fees (anyone) and buybacks (keeper)

    function collectFees(address coin) external nonReentrant returns (uint256 bnbFees, uint256 coinFees) {
        Race storage r = races[coin];
        if (r.state == State.None) revert NotOpen();
        if (r.state == State.Lost) revert RaceDone();
        return _collect(coin);
    }

    function _collect(address coin) internal returns (uint256 bnbFees, uint256 coinFees) {
        Race storage r = races[coin];
        uint256 bnbBefore = address(this).balance;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        _lock(abi.encode(Act.Collect, coin, bytes("")));
        bnbFees = address(this).balance - bnbBefore;
        coinFees = IERC20(coin).balanceOf(address(this)) - coinBefore;
        emit FeesCollected(coin, bnbFees, coinFees);
        if (bnbFees > 0) {
            uint256 toCoin = (bnbFees * CREATOR_SIDE_BPS) / BPS;
            _sendBnb(treasury, bnbFees - toCoin);
            if (r.feeMode == 1) {
                buybackFunds[coin] += toCoin;
                bnbReserved += toCoin;
                emit BuybackFunded(coin, toCoin);
            } else {
                _sendBnb(r.creator, toCoin);
            }
        }
        if (coinFees > 0) {
            uint256 toCoin = (coinFees * CREATOR_SIDE_BPS) / BPS;
            _sendCoins(coin, treasury, coinFees - toCoin);
            if (r.feeMode == 1) IRaceCoinPcs(coin).burn(toCoin);
            else _sendCoins(coin, r.creator, toCoin);
        }
    }

    /// @notice One buyback chunk. Only sasa's keeper (the hub's keeper), with a minimum it worked
    /// out just before: nobody can push the price up around a buyback and sell into it.
    function buyback(address coin, uint256 minCoinsOut) external nonReentrant returns (uint256 spent, uint256 burned) {
        address h = hub();
        if (h == address(0) || msg.sender != IRaceHubKeeperPcs(h).keeper()) revert NotKeeper();
        Race storage r = races[coin];
        if (r.state != State.Won && r.state != State.Racing) revert NotOpen();
        spent = Math.min(buybackFunds[coin], BUYBACK_CHUNK);
        if (spent == 0) revert NothingToDo();
        buybackFunds[coin] -= spent;
        bnbReserved -= spent;
        burned = _buy(coin, spent, address(this));
        if (burned < minCoinsOut) revert Slippage(burned, minCoinsOut);
        if (burned > 0) IRaceCoinPcs(coin).burn(burned);
        emit BuybackDone(coin, spent, burned);
    }

    function claimHeld() external nonReentrant {
        uint256 a = heldFor[msg.sender];
        if (a == 0) revert NothingToDo();
        heldFor[msg.sender] = 0;
        bnbReserved -= a;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert NothingToDo();
    }

    // ------------------------------------------------------------------ PancakeSwap Infinity (own calls only)

    function _lock(bytes memory data) private returns (bytes memory ret) {
        _inLock = true;
        ret = vault.lock(data);
        _inLock = false;
    }

    function _buy(address coin, uint256 bnbIn, address to) private returns (uint256 out) {
        out = abi.decode(_lock(abi.encode(Act.Buy, coin, abi.encode(bnbIn, to))), (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert OnlyVault();
        if (!_inLock) revert NotOurCall();
        (Act act, address coin, bytes memory p) = abi.decode(data, (Act, address, bytes));
        PoolKey memory key = poolKeyFor(coin);
        address to = address(this);
        uint256 out;
        if (act == Act.Mint) {
            (int24 lower, int24 upper, uint128 liquidity, bytes32 salt) = abi.decode(p, (int24, int24, uint128, bytes32));
            _modify(key, lower, upper, int256(uint256(liquidity)), salt);
        } else if (act == Act.Collect || act == Act.Unwind) {
            Race storage r = races[coin];
            bool all = act == Act.Unwind;
            _modifyAll(key, r.launchLower, r.launchUpper, bytes32(0), all);
            Range[] storage extra = _extra[coin];
            for (uint256 i; i < extra.length; ++i) {
                _modifyAll(key, extra[i].lower, extra[i].upper, bytes32(i + 1), all);
            }
        } else {
            uint256 bnbIn;
            uint160 limit = TickMath.MIN_SQRT_RATIO + 1;
            if (act == Act.BuyCapped) (bnbIn, to, limit) = abi.decode(p, (uint256, address, uint160));
            else (bnbIn, to) = abi.decode(p, (uint256, address));
            BalanceDelta d = poolManager.swap(
                key, ICLPoolManager.SwapParams({zeroForOne: true, amountSpecified: -int256(bnbIn), sqrtPriceLimitX96: limit}), bytes("")
            );
            int128 o = d.amount1();
            out = o > 0 ? uint256(uint128(o)) : 0;
        }
        _settle(BNB, address(this));
        _settle(key.currency1, to);
        return abi.encode(out);
    }

    function _modifyAll(PoolKey memory key, int24 lower, int24 upper, bytes32 salt, bool all) private {
        uint128 liq = poolManager.getLiquidity(key.toId(), address(this), lower, upper, salt);
        if (liq == 0) return;
        _modify(key, lower, upper, all ? -int256(uint256(liq)) : int256(0), salt);
    }

    function _modify(PoolKey memory key, int24 lower, int24 upper, int256 delta, bytes32 salt) private {
        poolManager.modifyLiquidity(
            key, ICLPoolManager.ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: delta, salt: salt}), bytes("")
        );
    }

    /// @dev Pays what this contract owes in `c` and takes what it is owed (to `to`).
    function _settle(Currency c, address to) private {
        int256 d = vault.currencyDelta(address(this), c);
        if (d < 0) {
            uint256 owe = uint256(-d);
            if (c.isNative()) {
                vault.settle{value: owe}();
            } else {
                vault.sync(c);
                IERC20(Currency.unwrap(c)).safeTransfer(address(vault), owe);
                vault.settle();
            }
        } else if (d > 0) {
            vault.take(c, to, uint256(d));
        }
    }

    // ------------------------------------------------------------------ the dollar leg (PancakeSwap v3 USDC/WBNB)

    function _usdcToBnb(uint256 usdcIn, uint256 minBnb) private returns (uint256 bnbOut) {
        uint256 w0 = IERC20(address(wbnb)).balanceOf(address(this));
        _v3Swap(usdcIsToken0, usdcIn);
        bnbOut = IERC20(address(wbnb)).balanceOf(address(this)) - w0;
        if (bnbOut < minBnb) revert Slippage(bnbOut, minBnb);
        wbnb.withdraw(bnbOut);
    }

    function _bnbToUsdc(uint256 bnbIn, uint256 minUsdc) private returns (uint256 usdcOut) {
        wbnb.deposit{value: bnbIn}();
        uint256 u0 = usdc.balanceOf(address(this));
        _v3Swap(!usdcIsToken0, bnbIn);
        usdcOut = usdc.balanceOf(address(this)) - u0;
        if (usdcOut < minUsdc) revert Slippage(usdcOut, minUsdc);
    }

    function _v3Swap(bool zeroForOne, uint256 amountIn) private {
        _inV3 = true;
        dollarPool.swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? V3_MIN_SQRT : V3_MAX_SQRT, bytes(""));
        _inV3 = false;
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(dollarPool) || !_inV3) revert NotOurCall();
        if (amount0Delta > 0) {
            IERC20(usdcIsToken0 ? address(usdc) : address(wbnb)).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(usdcIsToken0 ? address(wbnb) : address(usdc)).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    // ------------------------------------------------------------------ helpers

    function _amounts(int24 lower, int24 upper, uint128 liq, uint160 sqrtP) private pure returns (uint256 a0, uint256 a1) {
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        if (sqrtP <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, liq, false);
        } else if (sqrtP < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, liq, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, liq, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, liq, false);
        }
    }

    function _liquidityForAmount0(uint160 sa, uint160 sb, uint256 amount0) private pure returns (uint128) {
        uint256 intermediate = Math.mulDiv(sa, sb, FixedPoint96.Q96);
        return _toUint128(Math.mulDiv(amount0, intermediate, sb - sa));
    }

    function _liquidityForAmount1(uint160 sa, uint160 sb, uint256 amount1) private pure returns (uint128) {
        return _toUint128(Math.mulDiv(amount1, FixedPoint96.Q96, sb - sa));
    }

    function _toUint128(uint256 x) private pure returns (uint128) {
        return x > type(uint128).max ? type(uint128).max : uint128(x);
    }

    function _sendBnb(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            heldFor[to] += amount;
            bnbReserved += amount;
            emit HeldFor(to, amount);
        }
    }

    function _sendCoins(address coin, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = coin.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) IRaceCoinPcs(coin).burn(amount);
    }

    function _tickFloor(int24 t) private pure returns (int24) {
        int24 r = (t / TICK_SPACING) * TICK_SPACING;
        if (t < 0 && r != t) r -= TICK_SPACING;
        return r;
    }

    function _ratioToSqrtX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        uint256 s;
        if (amount1 / amount0 < (1 << 63)) {
            s = Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0));
        } else {
            s = Math.sqrt(Math.mulDiv(amount1, 1 << 96, amount0)) << 48;
        }
        if (s < TickMath.MIN_SQRT_RATIO) s = TickMath.MIN_SQRT_RATIO;
        if (s >= TickMath.MAX_SQRT_RATIO) s = TickMath.MAX_SQRT_RATIO - 1;
        return uint160(s);
    }
}
