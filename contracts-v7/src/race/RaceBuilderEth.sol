// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {RaceLaunchHook} from "./RaceLaunchHook.sol";
import {RaceMergerEth} from "./RaceMergerEth.sol";

interface IRaceHubKeeperEth {
    function keeper() external view returns (address);
}

interface IRaceFactoryHubEth {
    function hub() external view returns (address);
}

interface IRaceCoinEth is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function openBridge(uint32 winnerEid) external;
}

interface IRaceSeatBookEth {
    function bookHandOver(uint256 handed) external;
}

/// @notice Chainlink-style price feed (ETH/USD on Base and Robinhood Chain).
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/**
 * @title RaceBuilderEth (sasa v7, native pairs): a coin's ETH pool on Base / Robinhood Chain
 * @notice Same race as RaceBuilder (the USDC-pool builder, kept for Arc where USDC is the
 * chain's own money), but each coin's pool here is coin/ETH (native ETH), the pair trading
 * bots watch. Everything that enters or leaves this contract from the rest of sasa is still
 * dollars (USDC), so the factory, the seat, the hub, the consolidator and the dollar bridges
 * are the same reviewed contracts:
 *  1. launch: the pool opens at the dollar launch price, turned into ETH with the Chainlink
 *     ETH/USD price; the creator's first buy arrives in USDC and is swapped USDC -> ETH -> coin
 *     in one step (through the chain's deep ETH/USDC Uniswap pool);
 *  2. race report: the ETH in the pool, valued with Chainlink (never with a pool price, so a
 *     last-second trade can't move the result), in 6-decimal dollars on every chain;
 *  3. losing chain: all liquidity out once, unsold coins burned, pool closed, the ETH swapped
 *     to USDC (at least 98% of its Chainlink value) and handed over as before;
 *  4. winning chain: arriving USDC is swapped to ETH (at least 98% of its Chainlink value)
 *     and added below the price as ETH-only liquidity: the pool gets deeper, no coin minted.
 * Liquidity rules are unchanged: positions never leave this contract; the only removal is
 * the losing-chain hand-over, once, on the race verdict. The winning pool stays locked forever.
 */
contract RaceBuilderEth is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using PositionInfoLibrary for PositionInfo;

    uint24 public constant POOL_FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    int24 public constant TICK_SPACING = 200;
    uint256 public constant BPS = 10_000;
    uint256 public constant CREATOR_SIDE_BPS = 3_000; // 30% of pool fees to the coin side
    uint256 public constant GRAD_FEE_BPS = 200; // 2% of the dollars a losing pool hands over
    uint256 public constant MAX_SLIP_BPS = 200; // ETH <-> USDC swaps: at least 98% of the Chainlink value
    uint256 public constant RACE_SECONDS = 300;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant BUYBACK_CHUNK = 0.05 ether;
    uint8 public constant REPORT_DECIMALS = 6; // race money is reported in 6-decimal dollars on every chain
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    Currency internal constant ETH = Currency.wrap(address(0));

    enum State {
        None,
        Racing,
        Won,
        Lost
    }

    /// @notice The race result written down at the end of the five minutes (see recordRaceEnd).
    struct RaceEnd {
        uint256 money; // ETH in the launch position when the race ended
        uint256 coinsInPool; // coins in the launch position when the race ended
        bool recorded;
        int24 tick; // the pool's price when the race ended: arriving money is never placed above it
    }

    struct Race {
        uint256 positionId;
        address seat;
        address creator;
        uint8 feeMode; // 0 = fees to the creator, 1 = buyback & burn
        uint64 launchedAt;
        State state;
        uint32 winnerEid;
    }

    enum Op {
        BuyWithUsdc, // USDC -> ETH (dollar pool) -> coin (coin pool)
        BuyWithEth, // ETH -> coin (coin pool)
        EthToUsdc, // dollar pool
        UsdcToEth // dollar pool
    }

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;
    address public immutable treasury;
    RaceLaunchHook public immutable hook;
    IPriceFeed public immutable ethUsd;
    uint8 internal immutable feedDecimals;
    uint256 public immutable maxFeedAge;
    // the chain's deep native ETH / USDC Uniswap v4 pool (no hook)
    Currency internal immutable dollar0;
    Currency internal immutable dollar1;
    uint24 internal immutable dollarFee;
    int24 internal immutable dollarSpacing;
    address private immutable _deployer;
    /// @notice v8: does the merge (see `_merge`); created here, only this builder may use it.
    RaceMergerEth public immutable merger;

    address public factory;
    address public consolidator;
    address public bridge;

    mapping(address coin => Race) public races;
    mapping(bytes32 coinId => address coin) public coinOf;
    mapping(address coin => uint256[]) internal _extraPositions;
    mapping(address coin => uint256) public buybackFunds; // in ETH
    mapping(address coin => RaceEnd) public raceEnd;
    mapping(address coin => uint256) public pendingDollars; // arrived USDC waiting to be swapped to ETH
    mapping(address who => uint256) public heldFor; // ETH that could not be paid out
    mapping(address coin => uint256) public lostPending; // ETH of a losing pool waiting to be handed over
    uint256 public ethReserved; // buyback ETH + held ETH + losing hand-overs waiting
    uint256 public dollarsReserved; // pending USDC
    bool private _ownSwap;

    event Bound(address factory, address consolidator, address bridge);
    event PoolOpened(address indexed coin, uint256 indexed positionId, uint256 coinsIn, uint160 sqrtPriceX96, uint256 startMcEth);
    event RaceReported(address indexed coin, uint256 poolEth, uint256 dollars);
    event RaceWon(address indexed coin, uint32 winnerEid);
    event RaceLost(address indexed coin, uint32 winnerEid, uint256 ethOut, uint256 coinsBurned);
    event HandOverPending(address indexed coin, uint256 ethAmount);
    event HandedOver(address indexed coin, uint256 ethIn, uint256 usdcOut, uint256 gradFee);
    event Deepened(address indexed coin, uint256 indexed positionId, uint256 ethIn);
    /// @notice v8: part of the money that arrived from the losing chains bought coins in the pool.
    event ArrivalPending(address indexed coin, uint256 usdcAmount);
    event FeesCollected(address indexed coin, uint256 ethFees, uint256 coinFees);
    event BuybackFunded(address indexed coin, uint256 amount);
    event BuybackDone(address indexed coin, uint256 ethSpent, uint256 coinsBurned);
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
    error BadHookAddress(address hook);
    error BadDollarPool();
    error BadPrice();
    error OnlyPoolManager();
    error NotOurSwap();
    error NotSelf();
    error Slippage(uint256 got, uint256 minimum);
    error NotKeeper();

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        IERC20 usdc_,
        address treasury_,
        bytes32 hookSalt,
        PoolKey memory dollarKey,
        IPriceFeed ethUsd_,
        uint256 maxFeedAge_
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0) || address(permit2_) == address(0)
                || address(usdc_) == address(0) || treasury_ == address(0) || address(ethUsd_) == address(0) || maxFeedAge_ == 0
        ) revert ZeroAddress();
        // the dollar pool: native ETH (currency0) against this chain's USDC, no hook
        if (
            !dollarKey.currency0.isAddressZero() || Currency.unwrap(dollarKey.currency1) != address(usdc_)
                || address(dollarKey.hooks) != address(0)
        ) revert BadDollarPool();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        treasury = treasury_;
        ethUsd = ethUsd_;
        feedDecimals = ethUsd_.decimals();
        maxFeedAge = maxFeedAge_;
        dollar0 = dollarKey.currency0;
        dollar1 = dollarKey.currency1;
        dollarFee = dollarKey.fee;
        dollarSpacing = dollarKey.tickSpacing;
        _deployer = msg.sender;
        merger = new RaceMergerEth(poolManager_, positionManager_, permit2_);
        hook = new RaceLaunchHook{salt: hookSalt}(address(poolManager_), address(this));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != (Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG)) {
            revert BadHookAddress(address(hook));
        }
    }

    /// @dev ETH only comes in from Uniswap (swaps, removed liquidity, fees).
    receive() external payable {
        if (msg.sender != address(poolManager) && msg.sender != address(positionManager) && msg.sender != address(merger)) revert NotOurSwap();
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

    /// @notice The coin's pool: native ETH (always currency0) / coin.
    function poolKeyFor(address coin) public view returns (PoolKey memory) {
        return PoolKey({currency0: ETH, currency1: Currency.wrap(coin), fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});
    }

    function dollarPoolKey() public view returns (PoolKey memory) {
        return PoolKey({currency0: dollar0, currency1: dollar1, fee: dollarFee, tickSpacing: dollarSpacing, hooks: IHooks(address(0))});
    }

    function hub() public view returns (address) {
        return factory == address(0) ? address(0) : IRaceFactoryHubEth(factory).hub();
    }

    function positions(address coin) external view returns (uint256 tokenId, address creator) {
        Race storage r = races[coin];
        if (r.state == State.Racing || r.state == State.Won) return (r.positionId, r.creator);
        return (0, r.creator);
    }

    /// @notice ETH and coins in the coin's launch position right now (fees excluded).
    function poolAmounts(address coin) public view returns (uint256 ethAmount, uint256 coinAmount) {
        Race storage r = races[coin];
        if (r.positionId == 0) return (0, 0);
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolKeyFor(coin).toId());
        return _amountsIn(r.positionId, sqrtP);
    }

    function raceOver(address coin) public view returns (bool) {
        Race storage r = races[coin];
        return r.launchedAt != 0 && block.timestamp >= uint256(r.launchedAt) + RACE_SECONDS;
    }

    /// @notice Chainlink ETH/USD: dollars per ETH with `feedDecimals` decimals. Reverts when stale.
    function ethPrice() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsd.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxFeedAge) revert BadPrice();
        return uint256(answer);
    }

    /// @notice `weiAmount` of ETH in this chain's USDC units.
    function _ethToUsdc(uint256 weiAmount) internal view returns (uint256) {
        return Math.mulDiv(weiAmount, ethPrice() * 10 ** usdcDecimals, 10 ** (18 + uint256(feedDecimals)));
    }

    /// @notice `usdcAmount` (this chain's USDC units) in ETH.
    function _usdcToEth(uint256 usdcAmount) internal view returns (uint256) {
        return Math.mulDiv(usdcAmount, 10 ** (18 + uint256(feedDecimals)), ethPrice() * 10 ** usdcDecimals);
    }

    // ------------------------------------------------------------------ launch (factory)

    /**
     * @notice Opens `coin`'s ETH pool with this chain's `share` of the supply at a launch
     * market cap of `startMarketCap` (6-decimal dollars, the same number on every chain) for
     * the whole supply, priced in ETH with Chainlink: every chain opens at the same dollar price.
     */
    function open(bytes32 coinId, address coin, address seat, uint256 share, uint256 startMarketCap, address creator, uint8 feeMode)
        external
        nonReentrant
    {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        Race storage r = races[coin];
        if (r.state != State.None || coinOf[coinId] != address(0)) revert AlreadyOpen();
        coinOf[coinId] = coin;
        if (share == 0 || share > MAX_SUPPLY || startMarketCap == 0 || seat == address(0) || creator == address(0)) revert NothingToDo();
        uint256 startMcEth = Math.mulDiv(startMarketCap, 10 ** (18 + uint256(feedDecimals)), ethPrice() * 10 ** REPORT_DECIMALS);
        if (startMcEth == 0) revert NothingToDo();

        IRaceCoinEth(coin).mint(address(this), share);

        PoolKey memory key = poolKeyFor(coin);
        // ETH = currency0: the price (coins per ETH) falls as the coin gets dearer, so the
        // coin-only position sits entirely below the launch tick
        int24 upper = _tickFloor(TickMath.getTickAtSqrtPrice(_ratioToSqrtX96(startMcEth, MAX_SUPPLY)));
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        uint160 startSqrtPrice = TickMath.getSqrtPriceAtTick(upper);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), startSqrtPrice, share);
        if (liquidity == 0) revert NothingToDo();
        poolManager.initialize(key, startSqrtPrice);

        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        uint256 positionId = _newPosition(key, lower, upper, liquidity, 0, share, coin, share, 0);
        uint256 coinUsed = coinBefore - IERC20(coin).balanceOf(address(this));
        if (share > coinUsed) IRaceCoinEth(coin).burn(share - coinUsed);

        r.positionId = positionId;
        r.seat = seat;
        r.creator = creator;
        r.feeMode = feeMode;
        r.launchedAt = uint64(block.timestamp);
        r.state = State.Racing;
        emit PoolOpened(coin, positionId, coinUsed, startSqrtPrice, startMcEth);
    }

    /// @notice The creator's first buy on this chain: the factory sent `usdcAmount` USDC here;
    /// it is swapped USDC -> ETH -> coin (2% base fee in the coin pool), coins to `to`.
    function launchBuy(address coin, uint256 usdcAmount, uint256 minCoinsOut, address to)
        external
        nonReentrant
        returns (uint256 coinsOut)
    {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        if (races[coin].state != State.Racing) revert NotOpen();
        if (usdcAmount == 0) revert NothingToDo();
        if (usdc.balanceOf(address(this)) < dollarsReserved + usdcAmount) revert NotDelivered();
        // the USDC -> ETH leg must get a fair price too (at least 98% of Chainlink)
        uint256 minEth = (_usdcToEth(usdcAmount) * (BPS - MAX_SLIP_BPS)) / BPS;
        coinsOut = _swap(Op.BuyWithUsdc, coin, usdcAmount, minEth, to);
        if (coinsOut < minCoinsOut) revert Slippage(coinsOut, minCoinsOut);
    }

    // ------------------------------------------------------------------ the race (seat -> here)

    modifier onlySeat(address coin) {
        if (msg.sender != races[coin].seat || msg.sender == address(0)) revert NotSeat();
        _;
    }

    /**
     * @notice Called by the hook before the first swap after the five minutes: writes down
     * the ETH (and coins) in the pool as the race ended, before that swap moves anything.
     * Returns true once written (or when the race is decided), false while it is still on.
     * Never reverts for a race pool: a revert here would stop the swap. Anyone may call it too
     * (sasa's keeper does, right at the end, so no trader's swap pays for writing it): until it
     * is written, every swap writes it first, so the pool is still exactly as the race ended.
     * The key only names the coin; the builder reads its own pool. (The dollar value is
     * worked out at report time with Chainlink, as before.)
     */
    function recordRaceEnd(PoolKey calldata key) external returns (bool) {
        address coin = Currency.unwrap(key.currency1); // ETH is always currency0
        Race storage r = races[coin];
        RaceEnd storage e = raceEnd[coin];
        if (r.state != State.Racing || e.recorded) return true;
        if (!raceOver(coin)) return false;
        _writeRaceEnd(coin);
        return true;
    }

    function _writeRaceEnd(address coin) private {
        RaceEnd storage e = raceEnd[coin];
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(poolKeyFor(coin).toId());
        (e.money, e.coinsInPool) = _amountsIn(races[coin].positionId, sqrtP);
        e.tick = tick;
        e.recorded = true;
    }

    /// @notice Race report: the ETH in this chain's pool when the five minutes ended (written
    /// down before any later swap), in 6-decimal
    /// dollars at the Chainlink price (the same unit on every chain of the race).
    function report(address coin) external onlySeat(coin) returns (uint256 money, uint256 coinsOutside) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        if (!raceOver(coin)) revert RaceNotOver();
        RaceEnd storage e = raceEnd[coin];
        if (!e.recorded) _writeRaceEnd(coin); // no swap since the end: the pool is still as it ended
        (uint256 eth, uint256 inPool) = (e.money, e.coinsInPool);
        money = Math.mulDiv(eth, ethPrice() * 10 ** REPORT_DECIMALS, 10 ** (18 + uint256(feedDecimals)));
        uint256 supply = IERC20(coin).totalSupply();
        coinsOutside = supply > inPool ? supply - inPool : 0;
        emit RaceReported(coin, eth, money);
    }

    /**
     * @notice Race verdict for this chain. Winner: the pool goes on. Loser: fees out, all
     * liquidity out (once), unsold coins burned, pool closed, the ETH (and any buyback ETH)
     * swapped to USDC at no less than 98% of its Chainlink value, 2% graduation fee to the
     * treasury, the rest to the consolidator. Returns the dollars handed over.
     */
    function settle(address coin, uint32 winnerEid, bool isWinner) external onlySeat(coin) nonReentrant returns (uint256 handedOver) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        r.winnerEid = winnerEid;
        if (isWinner) {
            r.state = State.Won;
            IRaceCoinEth(coin).openBridge(winnerEid);
            emit RaceWon(coin, winnerEid);
            return 0;
        }
        r.state = State.Lost;
        _collect(coin);

        PoolKey memory key = poolKeyFor(coin);
        uint256 ethBefore = address(this).balance;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        uint128 liq = positionManager.getPositionLiquidity(r.positionId);
        if (liq > 0) {
            bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(r.positionId, uint256(liq), uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(key.currency0, key.currency1, address(this));
            positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        }
        uint256 ethOut = address(this).balance - ethBefore;
        uint256 coinsOut = IERC20(coin).balanceOf(address(this)) - coinBefore;
        hook.shutPool(key);
        if (coinsOut > 0) IRaceCoinEth(coin).burn(coinsOut);
        IRaceCoinEth(coin).openBridge(winnerEid);

        // the pool's ETH and any buyback ETH are swapped to USDC right away if the dollar pool
        // gives a fair price (at least 98% of Chainlink); otherwise the verdict still goes
        // through and anyone finishes it with `convertLost`
        uint256 bb = buybackFunds[coin];
        buybackFunds[coin] = 0;
        uint256 ethTotal = ethOut + bb;
        lostPending[coin] += ethTotal;
        ethReserved += ethOut; // `bb` was reserved already
        emit RaceLost(coin, winnerEid, ethTotal, coinsOut);
        if (ethTotal > 0) {
            try this.handOver(coin, ethTotal) returns (uint256 handed) {
                handedOver = handed; // the seat books it at the consolidator
            } catch {
                emit HandOverPending(coin, ethTotal);
            }
        }
    }

    /// @notice Finishes (part of) a losing chain's hand-over that waited for a fair price:
    /// `amount` ETH (0 = all that waits) -> USDC at least 98% of Chainlink -> consolidator.
    function convertLost(address coin, uint256 amount) external nonReentrant returns (uint256 handed) {
        if (races[coin].state != State.Lost) revert NotOpen();
        uint256 waiting = lostPending[coin];
        if (amount == 0 || amount > waiting) amount = waiting;
        if (amount == 0) revert NothingToDo();
        handed = _handOver(coin, amount);
        IRaceSeatBookEth(races[coin].seat).bookHandOver(handed);
    }

    /// @dev Only via `settle` (an external self-call, so a refused swap rolls back alone).
    function handOver(address coin, uint256 amount) external returns (uint256) {
        if (msg.sender != address(this)) revert NotSelf();
        return _handOver(coin, amount);
    }

    function _handOver(address coin, uint256 amount) private returns (uint256 handed) {
        lostPending[coin] -= amount;
        ethReserved -= amount;
        uint256 minUsdc = (_ethToUsdc(amount) * (BPS - MAX_SLIP_BPS)) / BPS;
        uint256 usdcOut = _swap(Op.EthToUsdc, coin, amount, minUsdc, address(this));
        uint256 gradFee = (usdcOut * GRAD_FEE_BPS) / BPS;
        if (gradFee > 0) usdc.safeTransfer(treasury, gradFee);
        handed = usdcOut - gradFee;
        if (handed > 0) usdc.safeTransfer(consolidator, handed);
        emit HandedOver(coin, amount, usdcOut, gradFee);
    }

    // ------------------------------------------------------------------ arrivals (winning chain)

    /**
     * @notice Called by the dollar bridge after it delivered `amount` USDC here for `coin`.
     * The USDC is swapped to ETH (at least 98% of the Chainlink value) and added to the pool
     * as ETH-only liquidity below the price (no coin minted), or funds buybacks. If the swap
     * can't be done right now (price moved, feed stale) the USDC waits here and anyone can
     * finish it later with `convertPending`.
     */
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

    /// @notice Finishes a pending arrival (USDC -> ETH -> pool). Anyone may call it.
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
        uint256 minEth = (_usdcToEth(amount) * (BPS - MAX_SLIP_BPS)) / BPS;
        uint256 eth = _swap(Op.UsdcToEth, coin, amount, minEth, address(this));
        if (toBuyback || !_merge(coin, eth)) {
            buybackFunds[coin] += eth;
            ethReserved += eth;
            emit BuybackFunded(coin, eth);
        }
    }


    /**
     * @notice v8 merge: the money from the losing chains shows up on the winning chain's
     * chart and liquidity. Half of it buys the coin in its own pool (the price rises, a
     * green candle), then the coins bought and the other half are added together as one
     * full-range position at the new price (the pool's liquidity grows where every screener
     * counts it). Nothing is minted; leftovers: ETH funds buybacks, coins are burned.
     * Done by `merger` (RaceMergerEth, kept apart for the contract size limit); the position
     * is this builder's. Returns false (the money funds buybacks instead) when the coin's
     * price is already more than 20% above where the race ended, so nobody can pump it just
     * before the money lands and sell into the merge buy.
     */
    function _merge(address coin, uint256 amount) internal returns (bool) {
        RaceEnd storage e = raceEnd[coin];
        if (amount < 2 || !e.recorded) return false;
        uint256 before = address(this).balance - amount;
        // the merger refuses (reverts) when the coin is already 20%+ above its race-end price
        (bool ok, bytes memory ret) = address(merger).call{value: amount}(abi.encodeCall(RaceMergerEth.merge, (poolKeyFor(coin), e.tick)));
        if (!ok) return false;
        uint256 positionId = abi.decode(ret, (uint256));
        uint256 back = address(this).balance - before;
        if (positionId != 0) {
            _extraPositions[coin].push(positionId);
            emit Deepened(coin, positionId, amount - back);
        }
        if (back > 0) {
            buybackFunds[coin] += back; // the ETH the position didn't take funds buybacks
            ethReserved += back;
        }
        return true;
    }

    // ------------------------------------------------------------------ fees (anyone) and buybacks (keeper)

    function collectFees(address coin) external nonReentrant returns (uint256 ethFees, uint256 coinFees) {
        Race storage r = races[coin];
        if (r.state == State.None) revert NotOpen();
        if (r.state == State.Lost) revert RaceDone();
        return _collect(coin);
    }

    function _collect(address coin) internal returns (uint256 ethFees, uint256 coinFees) {
        Race storage r = races[coin];
        PoolKey memory key = poolKeyFor(coin);
        uint256 ethBefore = address(this).balance;
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        uint256[] storage extra = _extraPositions[coin];
        uint256 n = 1 + extra.length;
        bytes memory actions;
        bytes[] memory params = new bytes[](n + 1);
        for (uint256 i; i < n; ++i) {
            uint256 id = i == 0 ? r.positionId : extra[i - 1];
            actions = abi.encodePacked(actions, uint8(Actions.DECREASE_LIQUIDITY));
            params[i] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        }
        actions = abi.encodePacked(actions, uint8(Actions.TAKE_PAIR));
        params[n] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        ethFees = address(this).balance - ethBefore;
        coinFees = IERC20(coin).balanceOf(address(this)) - coinBefore;
        emit FeesCollected(coin, ethFees, coinFees);
        if (ethFees > 0) {
            uint256 toCoin = (ethFees * CREATOR_SIDE_BPS) / BPS;
            _sendEth(treasury, ethFees - toCoin);
            if (r.feeMode == 1) {
                buybackFunds[coin] += toCoin;
                ethReserved += toCoin;
                emit BuybackFunded(coin, toCoin);
            } else {
                _sendEth(r.creator, toCoin);
            }
        }
        if (coinFees > 0) {
            uint256 toCoin = (coinFees * CREATOR_SIDE_BPS) / BPS;
            _sendCoins(coin, treasury, coinFees - toCoin);
            if (r.feeMode == 1) IRaceCoinEth(coin).burn(toCoin);
            else _sendCoins(coin, r.creator, toCoin);
        }
    }

    /// @notice Spends up to BUYBACK_CHUNK of `coin`'s buyback ETH on the coin and burns it.
    /// @notice One buyback chunk. Only sasa's keeper (the hub's keeper), with a minimum it worked
    /// out just before: nobody can push the price up around a buyback and sell into it.
    function buyback(address coin, uint256 minCoinsOut) external nonReentrant returns (uint256 spent, uint256 burned) {
        if (msg.sender != IRaceHubKeeperEth(hub()).keeper()) revert NotKeeper(); // no hub yet: the call itself fails
        Race storage r = races[coin];
        if (r.state != State.Won && r.state != State.Racing) revert NotOpen();
        spent = Math.min(buybackFunds[coin], BUYBACK_CHUNK);
        if (spent == 0) revert NothingToDo();
        buybackFunds[coin] -= spent;
        ethReserved -= spent;
        burned = _swap(Op.BuyWithEth, coin, spent, 0, address(this));
        if (burned < minCoinsOut) revert Slippage(burned, minCoinsOut);
        if (burned > 0) IRaceCoinEth(coin).burn(burned);
        emit BuybackDone(coin, spent, burned);
    }

    function claimHeld() external nonReentrant {
        uint256 a = heldFor[msg.sender];
        if (a == 0) revert NothingToDo();
        heldFor[msg.sender] = 0;
        ethReserved -= a;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert NothingToDo();
    }

    // ------------------------------------------------------------------ swaps (own only)

    /// @dev One Uniswap unlock: the swaps of `op`, then every open balance settled exactly.
    /// Returns the amount out of the last leg. `minMid` is the minimum of the USDC <-> ETH leg.
    function _swap(Op op, address coin, uint256 amountIn, uint256 minMid, address to) internal returns (uint256 out) {
        _ownSwap = true;
        out = abi.decode(poolManager.unlock(abi.encode(op, coin, amountIn, minMid, to)), (uint256));
        _ownSwap = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (!_ownSwap) revert NotOurSwap();
        (Op op, address coin, uint256 amountIn, uint256 minMid, address to) = abi.decode(data, (Op, address, uint256, uint256, address));
        PoolKey memory dk = dollarPoolKey();
        uint256 out;
        if (op == Op.BuyWithUsdc) {
            uint256 eth = _exactIn(dk, false, amountIn); // USDC (currency1) -> ETH
            if (eth < minMid) revert Slippage(eth, minMid);
            out = _exactIn(poolKeyFor(coin), true, eth); // ETH -> coin
            _settleAll(Currency.wrap(coin), to);
        } else if (op == Op.BuyWithEth) {
            out = _exactIn(poolKeyFor(coin), true, amountIn);
            _settleAll(Currency.wrap(coin), to);
        } else if (op == Op.EthToUsdc) {
            out = _exactIn(dk, true, amountIn); // ETH -> USDC
            if (out < minMid) revert Slippage(out, minMid);
            _settleAll(Currency.wrap(address(usdc)), to);
        } else {
            out = _exactIn(dk, false, amountIn); // USDC -> ETH
            if (out < minMid) revert Slippage(out, minMid);
            _settleAll(Currency.wrap(address(0)), to);
        }
        return abi.encode(out);
    }

    function _exactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) private returns (uint256 out) {
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );
        int128 o = zeroForOne ? d.amount1() : d.amount0();
        out = o > 0 ? uint256(uint128(o)) : 0;
    }

    /// @dev Pays what this contract owes (ETH, USDC, coin) and takes what it is owed. What
    /// is owed of `outCurrency` goes to `to`; any other credit (rounding) comes here.
    function _settleAll(Currency outCurrency, address to) private {
        Currency[3] memory cs = [ETH, Currency.wrap(address(usdc)), outCurrency];
        for (uint256 i; i < 3; ++i) {
            Currency c = cs[i];
            if (i == 2 && (c == cs[0] || c == cs[1])) break;
            int256 d = poolManager.currencyDelta(address(this), c);
            if (d < 0) {
                uint256 owe = uint256(-d);
                if (c.isAddressZero()) {
                    poolManager.settle{value: owe}();
                } else {
                    poolManager.sync(c);
                    IERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), owe);
                    poolManager.settle();
                }
            } else if (d > 0) {
                poolManager.take(c, c == outCurrency ? to : address(this), uint256(d));
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    function _newPosition(
        PoolKey memory key,
        int24 lower,
        int24 upper,
        uint128 liquidity,
        uint256 max0,
        uint256 max1,
        address token,
        uint256 amount,
        uint256 ethValue
    ) private returns (uint256 positionId) {
        if (token != address(0)) _letPositionManagerPull(token, amount);
        positionId = positionManager.nextTokenId();
        bytes memory actions;
        bytes[] memory params;
        if (ethValue > 0) {
            // native ETH: sent along, and whatever the position did not use comes back (SWEEP)
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
            params = new bytes[](3);
            params[2] = abi.encode(ETH, address(this));
        } else {
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
            params = new bytes[](2);
        }
        params[0] = abi.encode(key, lower, upper, uint256(liquidity), max0, max1, address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities{value: ethValue}(abi.encode(actions, params), block.timestamp);
        if (token != address(0)) _letPositionManagerPull(token, 0);
    }

    function _amountsIn(uint256 positionId, uint160 sqrtP) private view returns (uint256 a0, uint256 a1) {
        (, PositionInfo info) = positionManager.getPoolAndPositionInfo(positionId);
        uint128 liq = positionManager.getPositionLiquidity(positionId);
        uint160 sa = TickMath.getSqrtPriceAtTick(info.tickLower());
        uint160 sb = TickMath.getSqrtPriceAtTick(info.tickUpper());
        if (sqrtP <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, liq, false);
        } else if (sqrtP < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, liq, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, liq, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, liq, false);
        }
    }

    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            heldFor[to] += amount;
            ethReserved += amount;
            emit HeldFor(to, amount);
        }
    }

    function _sendCoins(address coin, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = coin.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) IRaceCoinEth(coin).burn(amount);
    }

    function _letPositionManagerPull(address token, uint256 amount) private {
        if (amount > 0) IERC20(token).forceApprove(address(permit2), type(uint256).max);
        else IERC20(token).forceApprove(address(permit2), 0);
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
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
        if (s < TickMath.MIN_SQRT_PRICE) s = TickMath.MIN_SQRT_PRICE;
        if (s >= TickMath.MAX_SQRT_PRICE) s = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
