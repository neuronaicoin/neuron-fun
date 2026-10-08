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
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {RaceLaunchHook} from "./RaceLaunchHook.sol";

interface IRaceCoin is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function openBridge(uint32 winnerEid) external;
}

/**
 * @title RaceBuilder (sasa v7): every coin's pool on this chain, from launch to the race result
 * @notice One per chain. For each coin launched here it:
 *  1. opens the coin's Uniswap v4 pool at launch with this chain's share of the supply,
 *     single-sided at the launch price (same price on every chain), and makes the creator's
 *     first buy (so DEX screeners see a real trade from the first block);
 *  2. reports the dollars in the pool when the 5-minute race ends (via the coin's seat);
 *  3. if this chain LOST: collects the pool fees, takes ALL liquidity out of the pool ONCE,
 *     burns the unsold coins, closes the pool, keeps the 2% graduation fee and hands the
 *     rest of the dollars to the consolidator, which bridges them to the winning chain;
 *     if this chain WON: nothing leaves; the pool stays as it is;
 *  4. on the winning chain, adds the dollars that arrive from losing chains to the coin's
 *     pool as buy-side liquidity (dollars only, below the current price): the pool gets
 *     deeper and NO coin is ever minted for it, so the total supply can only go down.
 *
 * Liquidity rules (the "locked" promise): positions never leave this contract. The only
 * function that removes liquidity is the losing-chain hand-over, which runs at most once
 * per coin, only on the race verdict (from the coin's seat, i.e. the cross-chain hub),
 * and only sends dollars to the consolidator and coins to the burn. After the race the
 * winning pool's liquidity is locked forever: there is no function that removes it.
 */
contract RaceBuilder is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using PositionInfoLibrary for PositionInfo;

    uint24 public constant POOL_FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    int24 public constant TICK_SPACING = 200;
    uint256 public constant BPS = 10_000;
    uint256 public constant CREATOR_SIDE_BPS = 3_000; // 30% of pool fees to the coin side
    uint256 public constant GRAD_FEE_BPS = 200; // 2% of the dollars a losing pool hands over
    uint256 public constant RACE_SECONDS = 300; // the race lasts five minutes
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether; // the launch price is set on the whole supply
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    enum State {
        None,
        Racing,
        Won,
        Lost
    }

    struct Race {
        uint256 positionId; // the launch position (coins, single-sided)
        address seat; // the coin's seat (the hub's handle for this coin here)
        address creator;
        uint8 feeMode; // 0 = fees to the creator, 1 = buyback & burn
        uint64 launchedAt;
        State state;
        uint32 winnerEid;
    }

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    IERC20 public immutable usdc;
    address public immutable treasury;
    RaceLaunchHook public immutable hook;
    uint256 public immutable BUYBACK_CHUNK;
    address private immutable _deployer;

    address public factory;
    address public consolidator;
    address public bridge; // the dollar bridge that delivers to this chain

    mapping(address coin => Race) public races;
    mapping(bytes32 coinId => address coin) public coinOf; // the hub/bridges name coins by id
    mapping(address coin => uint256[]) internal _extraPositions; // dollar-only positions added on the winning chain
    mapping(address coin => uint256) public buybackFunds;
    mapping(address who => uint256) public heldFor;
    uint256 public dollarsReserved; // dollars kept here for buybacks and failed payouts
    bool private _ownSwap;

    event Bound(address factory, address consolidator, address bridge);
    event PoolOpened(address indexed coin, uint256 indexed positionId, uint256 coinsIn, uint160 sqrtPriceX96);
    event RaceReported(address indexed coin, uint256 poolUsdc);
    event RaceWon(address indexed coin, uint32 winnerEid);
    event RaceLost(address indexed coin, uint32 winnerEid, uint256 usdcOut, uint256 coinsBurned, uint256 gradFee);
    event Deepened(address indexed coin, uint256 indexed positionId, uint256 usdcIn);
    event FeesCollected(address indexed coin, uint256 usdcFees, uint256 coinFees);
    event BuybackFunded(address indexed coin, uint256 amount);
    event BuybackDone(address indexed coin, uint256 usdcSpent, uint256 coinsBurned);
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
    error OnlyPoolManager();
    error NotOurSwap();
    error Slippage(uint256 got, uint256 minimum);

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        IERC20 usdc_,
        address treasury_,
        bytes32 hookSalt
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0) || address(permit2_) == address(0)
                || address(usdc_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        usdc = usdc_;
        treasury = treasury_;
        BUYBACK_CHUNK = 100 * 10 ** IERC20Metadata(address(usdc_)).decimals();
        _deployer = msg.sender;
        hook = new RaceLaunchHook{salt: hookSalt}(address(poolManager_), address(this));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != (Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG)) {
            revert BadHookAddress(address(hook));
        }
    }

    /// @notice Wires the factory, the consolidator and the dollar bridge, once, by the deployer.
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

    function usdcIsCurrency0(address coin) public view returns (bool) {
        return address(usdc) < coin;
    }

    function poolKeyFor(address coin) public view returns (PoolKey memory) {
        bool u0 = usdcIsCurrency0(coin);
        return PoolKey({
            currency0: Currency.wrap(u0 ? address(usdc) : coin),
            currency1: Currency.wrap(u0 ? coin : address(usdc)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// @notice For the v6 USD pool router (unchanged): a tradable pool's launch position and
    /// creator. A pool that lost its race reports no position, so the router refuses it.
    function positions(address coin) external view returns (uint256 tokenId, address creator) {
        Race storage r = races[coin];
        if (r.state == State.Racing || r.state == State.Won) return (r.positionId, r.creator);
        return (0, r.creator);
    }

    function extraPositions(address coin) external view returns (uint256[] memory) {
        return _extraPositions[coin];
    }

    /// @notice Dollars and coins in the coin's launch position right now (fees excluded).
    function poolAmounts(address coin) public view returns (uint256 usdcAmount, uint256 coinAmount) {
        Race storage r = races[coin];
        if (r.positionId == 0) return (0, 0);
        PoolKey memory key = poolKeyFor(coin);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = _amountsIn(r.positionId, sqrtP);
        bool u0 = usdcIsCurrency0(coin);
        return u0 ? (a0, a1) : (a1, a0);
    }

    /// @notice Whether the five-minute race of `coin` has ended here.
    function raceOver(address coin) public view returns (bool) {
        Race storage r = races[coin];
        return r.launchedAt != 0 && block.timestamp >= uint256(r.launchedAt) + RACE_SECONDS;
    }

    // ------------------------------------------------------------------ launch (factory)

    /**
     * @notice Opens `coin`'s pool with this chain's `share` of the supply at a launch market
     * cap of `startMarketCap` (in dollar units) for the WHOLE supply, so every chain opens at
     * the same price. The builder must be the coin's controller (it mints the share here).
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

        IRaceCoin(coin).mint(address(this), share);

        PoolKey memory key = poolKeyFor(coin);
        bool u0 = usdcIsCurrency0(coin);
        int24 lower;
        int24 upper;
        uint160 startSqrtPrice;
        uint128 liquidity;
        if (!u0) {
            // coin = currency0, price (dollars per coin) rises with the tick
            int24 t = TickMath.getTickAtSqrtPrice(_ratioToSqrtX96(MAX_SUPPLY, startMarketCap));
            lower = _tickCeil(t);
            upper = TickMath.maxUsableTick(TICK_SPACING);
            startSqrtPrice = TickMath.getSqrtPriceAtTick(lower);
            liquidity = LiquidityAmounts.getLiquidityForAmount0(startSqrtPrice, TickMath.getSqrtPriceAtTick(upper), share);
        } else {
            // coin = currency1, price (coins per dollar) falls as the coin gets dearer
            int24 t = TickMath.getTickAtSqrtPrice(_ratioToSqrtX96(startMarketCap, MAX_SUPPLY));
            upper = _tickFloor(t);
            lower = TickMath.minUsableTick(TICK_SPACING);
            startSqrtPrice = TickMath.getSqrtPriceAtTick(upper);
            liquidity = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), startSqrtPrice, share);
        }
        if (liquidity == 0) revert NothingToDo();
        poolManager.initialize(key, startSqrtPrice);

        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        uint256 positionId = _newPosition(key, lower, upper, liquidity, u0 ? 0 : share, u0 ? share : 0, coin, share);
        uint256 coinUsed = coinBefore - IERC20(coin).balanceOf(address(this));
        if (share > coinUsed) IRaceCoin(coin).burn(share - coinUsed); // rounding dust: burned, never kept

        r.positionId = positionId;
        r.seat = seat;
        r.creator = creator;
        r.feeMode = feeMode;
        r.launchedAt = uint64(block.timestamp);
        r.state = State.Racing;
        emit PoolOpened(coin, positionId, coinUsed, startSqrtPrice);
    }

    /// @notice The creator's first buy on this chain (at the 2% base fee). The factory has
    /// already sent `usdcAmount` here.
    function launchBuy(address coin, uint256 usdcAmount, uint256 minCoinsOut, address to)
        external
        nonReentrant
        returns (uint256 coinsOut)
    {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        if (races[coin].state != State.Racing) revert NotOpen();
        if (usdcAmount == 0) revert NothingToDo();
        if (usdc.balanceOf(address(this)) < dollarsReserved + usdcAmount) revert NotDelivered();
        uint256 spent;
        (coinsOut, spent) = _builderSwap(coin, usdcAmount, to);
        if (coinsOut < minCoinsOut) revert Slippage(coinsOut, minCoinsOut);
        if (spent < usdcAmount) _sendDollars(to, usdcAmount - spent);
    }

    // ------------------------------------------------------------------ the race (seat → here)

    modifier onlySeat(address coin) {
        if (msg.sender != races[coin].seat || msg.sender == address(0)) revert NotSeat();
        _;
    }

    /// @notice Race report: the dollars in this chain's pool once the race is over.
    /// Trading goes on; the verdict decides what happens to the pool.
    function report(address coin) external onlySeat(coin) returns (uint256 money, uint256 coinsOutside) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        if (!raceOver(coin)) revert RaceNotOver();
        uint256 inPool;
        (money, inPool) = poolAmounts(coin);
        uint256 supply = IERC20(coin).totalSupply();
        coinsOutside = supply > inPool ? supply - inPool : 0;
        emit RaceReported(coin, money);
    }

    /**
     * @notice Race verdict for this chain. Winner: the pool simply goes on. Loser: fees out,
     * all liquidity out (once), unsold coins burned, pool closed, 2% graduation fee to the
     * treasury, the rest of the dollars sent to the consolidator. Returns the dollars handed
     * over (0 on the winning chain).
     */
    function settle(address coin, uint32 winnerEid, bool isWinner) external onlySeat(coin) nonReentrant returns (uint256 handedOver) {
        Race storage r = races[coin];
        if (r.state != State.Racing) revert RaceDone();
        r.winnerEid = winnerEid;
        if (isWinner) {
            r.state = State.Won;
            IRaceCoin(coin).openBridge(winnerEid);
            emit RaceWon(coin, winnerEid);
            return 0;
        }
        r.state = State.Lost; // set first: nothing below can ever run twice
        _collect(coin);

        PoolKey memory key = poolKeyFor(coin);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 coinBefore = IERC20(coin).balanceOf(address(this));
        uint128 liq = positionManager.getPositionLiquidity(r.positionId);
        if (liq > 0) {
            bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(r.positionId, uint256(liq), uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(key.currency0, key.currency1, address(this));
            positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        }
        uint256 usdcOut = usdc.balanceOf(address(this)) - usdcBefore;
        uint256 coinsOut = IERC20(coin).balanceOf(address(this)) - coinBefore;
        hook.shutPool(key);
        if (coinsOut > 0) IRaceCoin(coin).burn(coinsOut);
        IRaceCoin(coin).openBridge(winnerEid);

        // leftover buyback money on this chain goes along with the pool money
        uint256 bb = buybackFunds[coin];
        if (bb > 0) {
            buybackFunds[coin] = 0;
            dollarsReserved -= bb;
        }
        uint256 gradFee = (usdcOut * GRAD_FEE_BPS) / BPS;
        _sendDollars(treasury, gradFee);
        handedOver = usdcOut - gradFee + bb;
        if (handedOver > 0) usdc.safeTransfer(consolidator, handedOver);
        emit RaceLost(coin, winnerEid, usdcOut, coinsOut, gradFee);
    }

    // ------------------------------------------------------------------ arrivals (winning chain)

    /**
     * @notice Called by the dollar bridge after it delivered `amount` here for `coin`.
     * Pool money is added to the coin's pool as buy-side liquidity (dollars only, just
     * below the current price): the pool gets deeper and no coin is minted. Buyback money
     * (or an amount too small to place) funds the coin's buybacks instead.
     */
    function receiveConsolidated(bytes32 coinId, uint256 amount, bool toBuyback) external nonReentrant {
        if (msg.sender != bridge || bridge == address(0)) revert NotBridge();
        address coin = coinOf[coinId];
        Race storage r = races[coin];
        if (r.state == State.None || r.state == State.Lost) revert NotOpen();
        if (amount == 0) revert NothingToDo();
        if (usdc.balanceOf(address(this)) < dollarsReserved + amount) revert NotDelivered();
        if (toBuyback || !_deepen(coin, amount)) {
            buybackFunds[coin] += amount;
            dollarsReserved += amount;
            emit BuybackFunded(coin, amount);
        }
    }

    function _deepen(address coin, uint256 amount) internal returns (bool) {
        PoolKey memory key = poolKeyFor(coin);
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        bool u0 = usdcIsCurrency0(coin);
        int24 lower;
        int24 upper;
        uint128 liquidity;
        if (!u0) {
            // dollars are currency1: a range entirely at or below the current tick holds only currency1
            upper = _tickFloor(tick);
            lower = TickMath.minUsableTick(TICK_SPACING);
            if (upper <= lower) return false;
            liquidity = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount);
        } else {
            // dollars are currency0: a range entirely above the current tick holds only currency0
            lower = _tickFloor(tick) + TICK_SPACING;
            upper = TickMath.maxUsableTick(TICK_SPACING);
            if (lower >= upper) return false;
            liquidity = LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount);
        }
        if (liquidity == 0) return false;
        uint256 before = usdc.balanceOf(address(this));
        uint256 positionId = _newPosition(key, lower, upper, liquidity, u0 ? amount : 0, u0 ? 0 : amount, address(usdc), amount);
        uint256 used = before - usdc.balanceOf(address(this));
        _extraPositions[coin].push(positionId);
        if (amount > used) {
            // rounding dust: funds buybacks
            buybackFunds[coin] += amount - used;
            dollarsReserved += amount - used;
        }
        emit Deepened(coin, positionId, used);
        return true;
    }

    // ------------------------------------------------------------------ fees and buybacks (anyone)

    /// @notice Collects the pool fees of `coin` (all its positions) and splits them 70/30.
    function collectFees(address coin) external nonReentrant returns (uint256 usdcFees, uint256 coinFees) {
        Race storage r = races[coin];
        if (r.state == State.None) revert NotOpen();
        if (r.state == State.Lost) revert RaceDone();
        return _collect(coin);
    }

    function _collect(address coin) internal returns (uint256 usdcFees, uint256 coinFees) {
        Race storage r = races[coin];
        PoolKey memory key = poolKeyFor(coin);
        uint256 usdcBefore = usdc.balanceOf(address(this));
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

        usdcFees = usdc.balanceOf(address(this)) - usdcBefore;
        coinFees = IERC20(coin).balanceOf(address(this)) - coinBefore;
        emit FeesCollected(coin, usdcFees, coinFees);
        if (usdcFees > 0) {
            uint256 toCoin = (usdcFees * CREATOR_SIDE_BPS) / BPS;
            _sendDollars(treasury, usdcFees - toCoin);
            if (r.feeMode == 1) {
                buybackFunds[coin] += toCoin;
                dollarsReserved += toCoin;
                emit BuybackFunded(coin, toCoin);
            } else {
                _sendDollars(r.creator, toCoin);
            }
        }
        if (coinFees > 0) {
            uint256 toCoin = (coinFees * CREATOR_SIDE_BPS) / BPS;
            _sendCoins(coin, treasury, coinFees - toCoin);
            if (r.feeMode == 1) IRaceCoin(coin).burn(toCoin);
            else _sendCoins(coin, r.creator, toCoin);
        }
    }

    /// @notice Spends up to BUYBACK_CHUNK of `coin`'s buyback money on the coin and burns it.
    function buyback(address coin) external nonReentrant returns (uint256 spent, uint256 burned) {
        Race storage r = races[coin];
        if (r.state != State.Won && r.state != State.Racing) revert NotOpen();
        spent = Math.min(buybackFunds[coin], BUYBACK_CHUNK);
        if (spent == 0) revert NothingToDo();
        buybackFunds[coin] -= spent;
        dollarsReserved -= spent;
        uint256 paid;
        (burned, paid) = _builderSwap(coin, spent, address(this));
        if (burned > 0) IRaceCoin(coin).burn(burned);
        if (paid < spent) {
            buybackFunds[coin] += spent - paid;
            dollarsReserved += spent - paid;
            spent = paid;
        }
        emit BuybackDone(coin, spent, burned);
    }

    function claimHeld() external nonReentrant {
        uint256 a = heldFor[msg.sender];
        if (a == 0) revert NothingToDo();
        heldFor[msg.sender] = 0;
        dollarsReserved -= a;
        usdc.safeTransfer(msg.sender, a);
    }

    // ------------------------------------------------------------------ swaps (own only)

    function _builderSwap(address coin, uint256 amountIn, address to) internal returns (uint256 out, uint256 paid) {
        _ownSwap = true;
        (out, paid) = abi.decode(poolManager.unlock(abi.encode(coin, amountIn, to)), (uint256, uint256));
        _ownSwap = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (!_ownSwap) revert NotOurSwap(); // only our own launch buy or buyback may swap here
        (address coin, uint256 amountIn, address to) = abi.decode(data, (address, uint256, address));
        PoolKey memory key = poolKeyFor(coin);
        bool zeroForOne = usdcIsCurrency0(coin);
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );
        int128 usdcDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 coinDelta = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 pay = uint256(uint128(-usdcDelta));
        uint256 out = uint256(uint128(coinDelta));
        poolManager.sync(Currency.wrap(address(usdc)));
        usdc.safeTransfer(address(poolManager), pay);
        poolManager.settle();
        poolManager.take(Currency.wrap(coin), to, out);
        return abi.encode(out, pay);
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
        uint256 amount
    ) private returns (uint256 positionId) {
        _letPositionManagerPull(token, amount);
        positionId = positionManager.nextTokenId();
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, lower, upper, uint256(liquidity), max0, max1, address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        _letPositionManagerPull(token, 0);
    }

    function _amountsIn(uint256 positionId, uint160 sqrtP) private view returns (uint256 a0, uint256 a1) {
        (, PositionInfo info) = positionManager.getPoolAndPositionInfo(positionId);
        int24 lower = info.tickLower();
        int24 upper = info.tickUpper();
        uint128 liq = positionManager.getPositionLiquidity(positionId);
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        if (sqrtP <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, liq, false);
        } else if (sqrtP < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, liq, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, liq, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, liq, false);
        }
    }

    function _sendDollars(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            heldFor[to] += amount;
            dollarsReserved += amount;
            emit HeldFor(to, amount);
        }
    }

    function _sendCoins(address coin, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = coin.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) IRaceCoin(coin).burn(amount);
    }

    function _letPositionManagerPull(address token, uint256 amount) private {
        if (amount > 0) IERC20(token).forceApprove(address(permit2), type(uint256).max);
        else IERC20(token).forceApprove(address(permit2), 0);
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
    }

    function _tickCeil(int24 t) private pure returns (int24) {
        int24 r = _tickFloor(t);
        return r < t ? r + TICK_SPACING : r;
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
