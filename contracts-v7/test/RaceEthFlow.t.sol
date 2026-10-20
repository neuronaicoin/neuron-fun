// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

import {OmniHub} from "../src/omni/OmniHub.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../src/omni/ConsolidatorV6.sol";
import {OmniCoinDeployer} from "../src/omni/OmniDeployers.sol";
import {RaceBuilder} from "../src/race/RaceBuilder.sol";
import {RaceBuilderEth, IPriceFeed} from "../src/race/RaceBuilderEth.sol";
import {RaceLaunchHook} from "../src/race/RaceLaunchHook.sol";
import {RaceTradeEth, IRaceBuilderEthPools} from "../src/race/RaceTradeEth.sol";
import {RaceCross, RaceCrossEth, IRaceRouter} from "../src/race/RaceCross.sol";
import {CrossSpoke, ICrossMinter} from "./CrossSpoke.sol";

/// A wallet that refuses native coins.
contract NoNativeEth {
    receive() external payable {
        revert("no thanks");
    }
}
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USD6, Swapper} from "./RaceFlow.sol";
import {MockBridgeDec, IMintBurn} from "./RacePcsFlow.t.sol";

/// Chainlink stand-in: 8 decimals, set by the test.
contract MockFeed is IPriceFeed {
    int256 public answer;
    uint256 public updatedAt;
    function set(int256 a, uint256 t) external { answer = a; updatedAt = t; }
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// Liquidity for the chain's deep ETH/USDC pool, and ETH swaps for outside traders.
contract EthDesk is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable pm;
    constructor(IPoolManager pm_) { pm = pm_; }
    receive() external payable {}

    function addFullRange(PoolKey memory key, uint128 liquidity) external payable {
        pm.unlock(abi.encode(uint8(0), msg.sender, key, true, uint256(liquidity)));
    }

    /// exact-in swap; native ETH in is sent as value, an ERC20 in is pulled from the caller
    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) external payable returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(uint8(1), msg.sender, key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (uint8 kind, address who, PoolKey memory key, bool z, uint256 x) = abi.decode(data, (uint8, address, PoolKey, bool, uint256));
        uint256 out;
        if (kind == 0) {
            int24 lo = TickMath.minUsableTick(key.tickSpacing);
            int24 hi = TickMath.maxUsableTick(key.tickSpacing);
            pm.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, int256(x), bytes32(0)), "");
        } else {
            BalanceDelta d = pm.swap(key, SwapParams({zeroForOne: z, amountSpecified: -int256(x),
                sqrtPriceLimitX96: z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), "");
            int128 o = z ? d.amount1() : d.amount0();
            out = uint256(uint128(o));
        }
        _settle(key.currency0, who);
        _settle(key.currency1, who);
        return abi.encode(out);
    }

    function _settle(Currency c, address who) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            uint256 owe = uint256(-d);
            if (c.isAddressZero()) {
                pm.settle{value: owe}();
            } else {
                pm.sync(c);
                IERC20(Currency.unwrap(c)).transferFrom(who, address(pm), owe);
                pm.settle();
            }
        } else if (d > 0) {
            pm.take(c, who, uint256(d));
        }
    }
}

/// Chain A (coordinator) runs the ETH builder (Base / Robinhood Chain); chain B the USDC
/// builder (Arc, where USDC is the chain's own money). One coin races on both.
/// Chain A is all local (RaceEthFlowTest) or the REAL Base / Robinhood Chain contracts on a
/// fork (test/fork/RaceEthFork.t.sol): Uniswap v4, the chain's ETH/dollar pool, its dollar
/// and Chainlink ETH/USD.
abstract contract EthRaceBase is Test, DeployPermit2 {
    uint32 constant A = 40_001;
    uint32 constant B = 40_002;
    uint256 constant D = 1e6;
    uint256 constant START_MC = 3_000 * D;
    uint256 constant SUPPLY = 1_000_000_000 ether;

    IAllowanceTransfer permit2;
    address treasury = address(0x7EA5);
    address keeper = address(0x6EE9);
    address creator = address(0xC4EA);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // chain A (ETH)
    IPoolManager pmA;
    IPositionManager posmA;
    IERC20 usdcA;
    IMintBurn minterA;
    IPriceFeed feed;
    PoolKey dollarKey;
    MockLzEndpoint epA;
    OmniHub hubA;
    RaceBuilderEth eb;

    /// @dev How many extra (arrival) positions the coin's pool got: the builder's `_extraPositions` (slot 6).
    function _extraCount(address c) internal view returns (uint256) {
        return uint256(vm.load(address(eb), keccak256(abi.encode(c, uint256(6)))));
    }
    RaceFactory facA;
    ConsolidatorV6 consA;
    MockBridgeDec brA;
    EthDesk desk;
    // chain B (USDC)
    IPoolManager pmB;
    IPositionManager posmB;
    USD6 usdcB;
    MockLzEndpoint epB;
    OmniHub hubB;
    RaceBuilder ub;
    RaceFactory facB;
    ConsolidatorV6 consB;
    MockBridgeDec brB;
    Swapper swB;

    // ---- what differs between the local run and the fork
    /// sets permit2, pmA, posmA, usdcA, minterA, feed, dollarKey
    function _setupChainA() internal virtual;
    function _freshFeed() internal virtual;
    function _maxFeedAge() internal pure virtual returns (uint256);
    function _bigUsdc() internal pure virtual returns (uint256);
    function _bigEth() internal pure virtual returns (uint256);

    function _v4() internal returns (IPoolManager pm, IPositionManager posm) {
        pm = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        posm = IPositionManager(deployCode("out/PositionManager.sol/PositionManager.json",
            abi.encode(pm, permit2, uint256(300_000), IPositionDescriptor(address(0)), IWETH9(address(0)))));
    }

    function _salt(address deployer, bytes memory initCode) internal pure returns (bytes32) {
        bytes32 h = keccak256(initCode);
        uint160 want = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        for (uint256 i; i < 1_000_000; ++i) {
            address x = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, bytes32(i), h)))));
            if (uint160(x) & Hooks.ALL_HOOK_MASK == want) return bytes32(i);
        }
        revert("no salt");
    }

    function _route() internal pure returns (RaceFactory.Route memory r) {
        address[] memory dvns = new address[](1);
        dvns[0] = address(0xD1);
        r.sendLib = address(0x5E);
        r.receiveLib = address(0x4E);
        r.ulnConfig = abi.encode(RaceFactory.UlnConfig(1, 1, 0, 0, dvns, new address[](0)));
    }

    function _ratioToSqrtX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
    }

    function setUp() public virtual {
        _setupChainA();
        desk = new EthDesk(pmA);
        epA = new MockLzEndpoint(A);
        hubA = new OmniHub(address(epA), address(this), A, A);
        brA = new MockBridgeDec(usdcA, minterA, 6);
        {
            address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
            bytes32 salt = _salt(predicted, abi.encodePacked(type(RaceLaunchHook).creationCode, abi.encode(address(pmA), predicted)));
            eb = new RaceBuilderEth(pmA, posmA, permit2, usdcA, treasury, salt, dollarKey, feed, _maxFeedAge());
            require(address(eb) == predicted, "builder address");
        }
        consA = new ConsolidatorV6(usdcA, IHubLocal(address(hubA)), IUsdcBridge(address(brA)));
        {
            address factoryAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
            OmniCoinDeployer cd = new OmniCoinDeployer(factoryAt);
            facA = new RaceFactory(address(this), ILayerZeroEndpointV2(address(epA)), A, usdcA,
                address(hubA), address(eb), treasury, 1, cd, START_MC, 5 * D, 10);
            require(address(facA) == factoryAt, "factory address");
        }
        eb.bind(address(facA), address(consA), address(brA));
        hubA.setFactory(address(facA));
        hubA.setKeeper(keeper);
        facA.setLaunchesOpen(true);

        // ---- chain B: the USDC builder
        (pmB, posmB) = _v4();
        usdcB = new USD6();
        epB = new MockLzEndpoint(B);
        hubB = new OmniHub(address(epB), address(this), A, B);
        brB = new MockBridgeDec(IERC20(address(usdcB)), IMintBurn(address(usdcB)), 6);
        {
            address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
            bytes32 salt = _salt(predicted, abi.encodePacked(type(RaceLaunchHook).creationCode, abi.encode(address(pmB), predicted)));
            ub = new RaceBuilder(pmB, posmB, permit2, IERC20(address(usdcB)), treasury, salt);
            require(address(ub) == predicted, "builder B address");
        }
        consB = new ConsolidatorV6(IERC20(address(usdcB)), IHubLocal(address(hubB)), IUsdcBridge(address(brB)));
        {
            address factoryAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
            OmniCoinDeployer cd = new OmniCoinDeployer(factoryAt);
            facB = new RaceFactory(address(this), ILayerZeroEndpointV2(address(epB)), B, IERC20(address(usdcB)),
                address(hubB), address(ub), treasury, 1, cd, START_MC, 5 * D, 10);
            require(address(facB) == factoryAt, "factory B address");
        }
        ub.bind(address(facB), address(consB), address(brB));
        hubB.setFactory(address(facB));
        hubB.setKeeper(keeper);
        facB.setLaunchesOpen(true);
        swB = new Swapper(pmB);

        hubA.setPeer(B, bytes32(uint256(uint160(address(hubB)))));
        hubB.setPeer(A, bytes32(uint256(uint160(address(hubA)))));
        facA.setRoute(B, _route());
        facB.setRoute(A, _route());
        brA.link(brB, address(eb));
        brB.link(brA, address(ub));

        minterA.mint(creator, 1_000 * D);
        usdcB.mint(creator, 1_000 * D);
        usdcB.mint(alice, 100_000 * D);
        usdcB.mint(bob, 100_000 * D);
        vm.prank(creator);
        usdcA.approve(address(facA), type(uint256).max);
        vm.prank(creator);
        usdcB.approve(address(facB), type(uint256).max);
        vm.prank(alice);
        usdcB.approve(address(swB), type(uint256).max);
        vm.prank(bob);
        usdcB.approve(address(swB), type(uint256).max);
        vm.prank(bob);
        usdcA.approve(address(desk), type(uint256).max);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _eids() internal pure returns (uint32[] memory e) {
        e = new uint32[](2);
        e[0] = A;
        e[1] = B;
    }

    address coinB; // the coin on chain B (its own address in this single-EVM test)

    function _launchBoth(uint256 firstA, uint256 firstB, uint8 mode) internal returns (address coin) {
        RaceFactory.Launch memory la = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids(), mode, firstA, 0);
        RaceFactory.Launch memory lb = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids(), mode, firstB, 0);
        vm.prank(creator);
        (coin,) = facA.launch(la);
        vm.prank(creator);
        (coinB,) = facB.launch(lb);
    }

    function _buyEth(address coin, address who, uint256 wei_) internal returns (uint256) {
        PoolKey memory k = eb.poolKeyFor(coin);
        vm.prank(who);
        return desk.swap{value: wei_}(k, true, wei_);
    }

    function _buyUsd(address coin, address who, uint256 usd) internal returns (uint256) {
        coin;
        PoolKey memory k = ub.poolKeyFor(coinB);
        bool z = ub.usdcIsCurrency0(coinB);
        vm.prank(who);
        return swB.swap(k, z, usd);
    }

    /// bob makes ETH dear in the dollar pool (big USDC -> ETH); returns the ETH he got
    function _ethDear() internal returns (uint256 ethGot) {
        minterA.mint(bob, _bigUsdc());
        vm.prank(bob);
        ethGot = desk.swap(dollarKey, false, _bigUsdc());
    }

    /// bob makes ETH cheap in the dollar pool (big ETH -> USDC); returns the USDC he got
    function _ethCheap() internal returns (uint256 usdcGot) {
        vm.deal(bob, bob.balance + _bigEth());
        vm.prank(bob);
        usdcGot = desk.swap{value: _bigEth()}(dollarKey, true, _bigEth());
    }

    function _coinId() internal view returns (bytes32) {
        return facA.coinIdOf(creator, bytes32("k1"));
    }

    function _endRace() internal {
        _freshFeed();
        bytes32 id = _coinId();
        vm.startPrank(keeper);
        hubA.freeze(id, "");
        hubB.freeze(id, "");
        vm.stopPrank();
        epA.deliver(epB.packetAt(epB.packetCount() - 1));
        hubA.finalize(id, 0, "");
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
    }

    function _stateA(address coin) internal view returns (RaceBuilderEth.State st) {
        (,,,,, st,) = eb.races(coin);
    }

    function _stateB(address coin) internal view returns (RaceBuilder.State st) {
        (,,,,, st,) = ub.races(coin);
    }

    /// ETH in chain A's dollars at the builder's Chainlink price (the builder's own maths, which is internal)
    function _ethUsdc(uint256 wei_) internal view returns (uint256) {
        return (wei_ * eb.ethPrice() * 10 ** uint256(eb.usdcDecimals())) / 10 ** (18 + uint256(feed.decimals()));
    }

    /// ETH in 6-decimal dollars at the Chainlink price
    function _usd(uint256 wei_) internal view returns (uint256) {
        return _ethUsdc(wei_);
    }

    // ------------------------------------------------------------------ tests

    /// The coin opens on both chains at the same dollar price: on A as a coin/ETH pool,
    /// on B as a coin/USDC pool; the creator's $5 first buy on A went USDC -> ETH -> coin.
    function test_launchSamePriceBothPairs() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        PoolKey memory k = eb.poolKeyFor(coin);
        assertTrue(k.currency0.isAddressZero(), "A pool is coin/ETH");
        (uint256 eth, uint256 coinsA) = eb.poolAmounts(coin);
        (uint256 usd, uint256 coinsB) = ub.poolAmounts(coinB);
        // ~$4.90 lands in each pool (2% base fee; on A also the dollar pool fee)
        assertApproxEqRel(_usd(eth), 4_900_000, 0.015e18);
        assertApproxEqAbs(usd, 4_900_000, 2);
        assertGt(IERC20(coin).balanceOf(creator), 0);
        assertApproxEqRel(coinsA, coinsB, 0.015e18);
        assertEq(address(eb).balance, 0, "builder keeps no ETH");
        assertEq(usdcA.balanceOf(address(eb)), 0, "builder keeps no USDC");
    }

    /// The opening fee applies to ETH buys too: ~10% in the first second, 70% of it to the treasury in ETH.
    function test_launchFeeInEth() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        uint256 t0 = treasury.balance;
        _buyEth(coin, alice, 1 ether);
        eb.collectFees(coin);
        assertApproxEqRel(treasury.balance - t0, (0.1 ether * 70) / 100, 0.02e18);
    }

    /// ETH chain wins: the USDC chain's pool money crosses and deepens the ETH pool (as ETH).
    function test_ethChainWins() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.2 ether);
        _buyUsd(coin, bob, 100 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Won));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Lost));
        assertGt(consB.pendingPool(_coinId()), 0);
        uint256 extra0 = _extraCount(coin);
        consB.forward(_coinId());
        assertEq(_extraCount(coin), extra0 + 1, "ETH pool got deeper");
        assertEq(eb.pendingDollars(coin), 0);
        assertEq(usdcA.balanceOf(address(eb)), 0, "all arriving USDC became ETH");
        assertGt(_buyEth(coin, bob, 0.01 ether), 0);
    }

    /// The coin's price on the ETH chain, growing when the coin gets dearer (ETH = currency0).
    function _tickPriceA(address coin) internal view returns (int256) {
        (, int24 tick,,) = StateLibrary.getSlot0(pmA, PoolIdLibrary.toId(eb.poolKeyFor(coin)));
        return -int256(tick);
    }

    /// v8: the money from the losing chain lifts the ETH chain's price and lands as liquidity.
    function test_mergeRaisesPriceEth() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.2 ether);
        _buyUsd(coin, bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Won));
        uint256 supply0 = IERC20(coin).totalSupply();
        int256 p0 = _tickPriceA(coin);
        consB.forward(_coinId());
        assertGt(_tickPriceA(coin), p0, "the merge buy lifted the price");
        assertEq(_extraCount(coin), 1);
        assertLe(IERC20(coin).totalSupply(), supply0, "nothing minted");
        assertEq(usdcA.balanceOf(address(eb)), 0, "all arriving USDC used");
        assertGt(_buyEth(coin, bob, 0.01 ether), 0);
    }

    /// v8: a pumped coin (>20% above its race-end price) gets no merge buy.
    function test_mergeSkipsPumpedCoinEth() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.2 ether);
        _buyUsd(coin, bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        _buyEth(coin, bob, 1 ether);
        int256 p0 = _tickPriceA(coin);
        consB.forward(_coinId());
        assertEq(_tickPriceA(coin), p0, "no merge buy on a pumped coin");
        assertEq(_extraCount(coin), 0, "no position on a pumped coin");
        assertGt(eb.buybackFunds(coin), 0, "the money funds buybacks instead");
    }

    /// USDC chain wins: the ETH pool is emptied once, its ETH swapped to USDC at a fair price.
    function test_usdcChainWins() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.02 ether);
        _buyUsd(coin, bob, 500 * D);
        vm.warp(block.timestamp + 301);
        (uint256 ethInPool,) = eb.poolAmounts(coin);
        uint256 t0 = usdcA.balanceOf(treasury);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Lost));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        (uint256 e1, uint256 c1) = eb.poolAmounts(coin);
        assertEq(e1 + c1, 0, "ETH pool emptied");
        assertEq(eb.lostPending(coin), 0, "handed over at once");
        assertGe(consA.pendingPool(_coinId()), (_usd(ethInPool) * 98 * 98) / (100 * 100));
        assertGt(usdcA.balanceOf(treasury) - t0, 0, "graduation fee");
        assertEq(address(eb).balance, 0, "no ETH left behind");
        PoolKey memory k = eb.poolKeyFor(coin);
        vm.prank(alice);
        vm.expectRevert();
        desk.swap{value: 0.01 ether}(k, true, 0.01 ether);
        consA.forward(_coinId());
        assertEq(ub.extraPositions(coinB).length, 1);
    }

    /// Once the race is over, a big ETH buy on the losing ETH chain can't make it win: the ETH
    /// in the pool when the five minutes ended is what counts (written down before that buy).
    function test_lateBuyCantFlipRace() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.02 ether);
        _buyUsd(coin, bob, 500 * D);
        vm.warp(block.timestamp + 301); // B leads
        (uint256 ethAtEnd, uint256 coinsAtEnd) = eb.poolAmounts(coin);
        _buyEth(coin, bob, 5 ether); // after the end: would be ~$12,500 more on A
        (uint256 liveEth,) = eb.poolAmounts(coin);
        assertGt(_usd(liveEth), 500 * D, "the live pool would say A");
        (uint256 m, uint256 c, bool rec,) = eb.raceEnd(coin);
        assertTrue(rec);
        assertEq(m, ethAtEnd, "the ETH before the late buy");
        assertEq(c, coinsAtEnd);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Lost));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        // asking again (anyone may) changes nothing
        PoolKey memory key = eb.poolKeyFor(coin);
        vm.prank(alice);
        assertTrue(eb.recordRaceEnd(key));
    }

    /// The losing chain's dollars arrive on the ETH chain as ETH buy orders. Pushing the price up
    /// just before and selling into them afterwards must not pay (never placed above the price
    /// the race ended at).
    function test_pumpBeforeArrivalGainsNothing() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 2 ether); // about $5,000
        _buyUsd(coin, bob, 3_000 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Won));
        uint256 b0 = bob.balance;
        _buyEth(coin, bob, 6 ether);
        uint256 extra0 = _extraCount(coin);
        consB.forward(_coinId());
        assertEq(_extraCount(coin), extra0, "pumped: nothing placed in the pool");
        assertGt(eb.buybackFunds(coin), 0, "the money funds buybacks instead");
        PoolKey memory k = eb.poolKeyFor(coin);
        vm.startPrank(bob);
        IERC20(coin).approve(address(desk), type(uint256).max);
        desk.swap(k, false, IERC20(coin).balanceOf(bob));
        vm.stopPrank();
        assertLt(bob.balance, b0, "no profit from pushing the price");
    }

    /// The race is judged with Chainlink, never the pool price: a stale feed stops the report.
    function test_staleFeedStopsReport() public {
        _launchBoth(5 * D, 5 * D, 0);
        vm.warp(block.timestamp + 301 + _maxFeedAge() + 1 hours);
        bytes32 id = _coinId();
        vm.prank(keeper);
        vm.expectRevert(RaceBuilderEth.BadPrice.selector);
        hubA.freeze(id, "");
    }

    /// Arriving USDC waits when the ETH/USDC swap would be unfair, then anyone finishes it.
    function test_arrivalWaitsWhenUnfair() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.2 ether);
        vm.warp(block.timestamp + 301);
        _endRace();
        uint256 ethGot = _ethDear();
        consB.forward(_coinId());
        assertGt(eb.pendingDollars(coin), 0, "USDC waits instead of a bad swap");
        assertEq(_extraCount(coin), 0);
        // the market comes back; anyone completes the arrival
        vm.prank(bob);
        desk.swap{value: ethGot}(dollarKey, true, ethGot);
        eb.convertPending(coin);
        assertEq(eb.pendingDollars(coin), 0);
        assertEq(_extraCount(coin), 1);
    }

    /// A losing hand-over at an unfair ETH price waits (the verdict still goes through);
    /// once the market is back, anyone finishes it, in parts if they like.
    function test_unfairHandOverWaits() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, 0.02 ether);
        _buyUsd(coin, bob, 500 * D);
        vm.warp(block.timestamp + 301);
        uint256 got = _ethCheap();
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderEth.State.Lost), "verdict went through");
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        uint256 waiting = eb.lostPending(coin);
        assertGt(waiting, 0, "ETH waits instead of a bad swap");
        assertEq(consA.pendingPool(_coinId()), 0);
        assertEq(address(eb).balance, eb.ethReserved());
        vm.expectRevert();
        eb.convertLost(coin, 0);
        // the market comes back
        vm.prank(bob);
        desk.swap(dollarKey, false, got);
        eb.convertLost(coin, waiting / 2);
        eb.convertLost(coin, 0);
        assertEq(eb.lostPending(coin), 0);
        assertEq(address(eb).balance, 0, "no ETH left behind");
        assertGe(consA.pendingPool(_coinId()), (_usd(waiting) * 97) / 100);
        consA.forward(_coinId());
        assertEq(ub.extraPositions(coinB).length, 1, "money reached B");
    }

    /// Only Uniswap may send ETH here; the internal steps can't be called from outside.
    function test_accessRules() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        vm.prank(alice);
        (bool ok,) = address(eb).call{value: 1 ether}("");
        assertFalse(ok);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotSelf.selector);
        eb.placeArrived(coin, 1, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotSelf.selector);
        eb.handOver(coin, 1);
        bytes32 id = _coinId();
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotBridge.selector);
        eb.receiveConsolidated(id, 1, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotSeat.selector);
        eb.settle(coin, B, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotOpen.selector);
        eb.convertLost(coin, 0);
    }

    /// Buyback & burn mode on the ETH chain: the coin's 30% (in ETH) buys and burns the coin.
    function test_buybackModeEth() public {
        address coin = _launchBoth(5 * D, 5 * D, 1);
        _buyEth(coin, alice, 1 ether);
        eb.collectFees(coin);
        assertGt(eb.buybackFunds(coin), 0);
        uint256 s0 = IERC20(coin).totalSupply();
        vm.prank(alice);
        vm.expectRevert(RaceBuilderEth.NotKeeper.selector);
        eb.buyback(coin, 1);
        vm.prank(keeper);
        (uint256 spent, uint256 burned) = eb.buyback(coin, 1);
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(IERC20(coin).totalSupply(), s0 - burned);
    }

    /// Users trade with USDC only: USDC -> ETH -> coin and back in one call each.
    function test_tradeWithUsdc() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        vm.warp(block.timestamp + 301); // opening fee over: 2%
        RaceTradeEth t = new RaceTradeEth(IRaceBuilderEthPools(address(eb)));
        minterA.mint(alice, 100 * D);
        vm.startPrank(alice);
        usdcA.approve(address(t), type(uint256).max);
        IERC20(coin).approve(address(t), type(uint256).max);
        uint256 u0 = usdcA.balanceOf(alice);
        uint256 got = t.buy(coin, 100 * D, 1, alice, block.timestamp);
        assertGt(got, 0);
        assertEq(usdcA.balanceOf(alice), u0 - 100 * D);
        uint256 back = t.sell(coin, got, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(back, 94 * D, "round trip");
        assertLt(back, 100 * D);
        assertEq(IERC20(coin).balanceOf(alice), 0);
        assertEq(address(t).balance, 0, "router keeps no ETH");
        assertEq(usdcA.balanceOf(address(t)), 0, "router keeps no USDC");
        assertEq(IERC20(coin).balanceOf(address(t)), 0, "router keeps no coins");
        minterA.mint(alice, 10 * D);
        vm.startPrank(alice);
        vm.expectRevert();
        t.buy(coin, 10 * D, type(uint256).max, alice, block.timestamp);
        vm.expectRevert(RaceTradeEth.Expired.selector);
        t.buy(coin, 10 * D, 1, alice, block.timestamp - 1);
        vm.stopPrank();
        vm.expectRevert(RaceTradeEth.OnlyPoolManager.selector);
        t.unlockCallback("");
    }

    /// A sasa account (dollars on Base) launches here through Across with its signature: the
    /// coin, fees and first-buy coins are the user's, a little of the money becomes gas, the
    /// change goes back to the user, nothing stays in RaceCross.
    function test_crossLaunch() public {
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossEth x = new RaceCrossEth(spoke, IRaceBuilderEthPools(address(eb)), IRaceRouter(address(new RaceTradeEth(IRaceBuilderEthPools(address(eb))))), facA, 8453,
            IERC20(address(0xBA5E)), 6, 0.00005 ether);
        facA.setLauncher(address(x));
        uint256 pk = 0xA11CE5EC2E7;
        address u = vm.addr(pk);
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Dog", "MDOG", "", "", bytes32("k9"), _eids(), 0, 5 * D, 0);
        uint256 dl = vm.getBlockTimestamp() + 10 minutes;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, x.launchDigest(u, l, 30 * D / 100, dl));
        bytes memory m = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(u, l, 30 * D / 100, dl, abi.encodePacked(r, sg, v))));
        uint256 g0 = gasleft();
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 6 * D, m);
        emit log_named_uint("cross launch fill gas", g0 - gasleft());
        assertLt(g0 - gasleft(), 7_000_000, "a launch fill fits easily in a block");
        address coin = facA.coinAddress(u, bytes32("k9"));
        assertGt(coin.code.length, 0, "launched");
        assertGt(IERC20(coin).balanceOf(u), 0, "first-buy coins are the creator's");
        assertGt(u.balance, 0, "gas topped up");
        assertEq(usdcA.balanceOf(u), 6 * D - 5 * D - facA.raceFee() - 30 * D / 100, "change back");
        assertEq(usdcA.balanceOf(address(x)), 0, "nothing kept");
        assertEq(address(x).balance, 0);
        // the same order again can't launch twice: refused (Across returns the dollars on Base)
        vm.expectRevert(RaceCross.AlreadyLaunched.selector);
        spoke.fill{gas: 1_000_000}(address(usdcA), ICrossMinter(address(minterA)), address(x), 6 * D, m);
    }

    /// Dollars kept on Base buy here through Across: a user with no ETH gets a little gas and the
    /// coins; selling sends the dollars home to Base in the same transaction; a failed buy refunds.
    function test_crossBuyAndSellHome() public {
        address coin = _launchBoth(5 * D, 5 * D, 0);
        vm.warp(block.timestamp + 301);
        RaceTradeEth t = new RaceTradeEth(IRaceBuilderEthPools(address(eb)));
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossEth x = new RaceCrossEth(spoke, IRaceBuilderEthPools(address(eb)), IRaceRouter(address(t)), facA, 8453, IERC20(address(0xBA5E)), 6, 0.00005 ether); // top-up below ~12 cents of ETH
        address u = address(0xC0FFEE01);
        assertEq(u.balance, 0);

        // buy $20 from Base, 30 cents of it as gas
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 20 * D,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(u, coin, 1, 30 * D / 100, block.timestamp + 1 hours))));
        uint256 coins = IERC20(coin).balanceOf(u);
        assertGt(coins, 0, "coins delivered");
        assertGt(u.balance, 0, "gas delivered");
        {
            (, int256 px,,,) = feed.latestRoundData(); // 8 decimals
            uint256 cents = (u.balance * uint256(px) * 100) / 1e26;
            assertGe(cents, 28, "about 30 cents of ETH (pool fee and price gap aside)");
            assertLe(cents, 31, "not more than asked");
        }
        assertEq(usdcA.balanceOf(address(x)), 0, "nothing kept");
        assertEq(address(x).balance, 0, "no ETH kept");

        // a second buy: the user has gas now, all of it buys coins
        uint256 g = u.balance;
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 5 * D,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(u, coin, 1, 30 * D / 100, block.timestamp + 1 hours))));
        assertEq(u.balance, g, "no second top-up");

        // sell everything; the dollars head home to the user on Base
        coins = IERC20(coin).balanceOf(u);
        vm.startPrank(u);
        IERC20(coin).approve(address(x), coins);
        uint256 got = x.sellAndSendHome(coin, coins, 1, D / 100, block.timestamp);
        vm.stopPrank();
        assertGt(got, 20 * D, "sold for most of the $24.70 put in");
        assertEq(spoke.lastDepositor(), u);
        assertEq(spoke.lastRecipient(), u);
        assertEq(spoke.lastDst(), 8453);
        assertEq(spoke.lastOutput(), got - D / 100);
        assertEq(IERC20(coin).balanceOf(address(x)), 0);
        assertEq(usdcA.balanceOf(address(x)), 0);

        // a wallet that refuses ETH loses only its top-up: the whole amount buys coins
        {
            address w = address(new NoNativeEth());
            spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 10 * D,
                abi.encode(uint8(0), abi.encode(RaceCross.Order(w, coin, 1, 30 * D / 100, block.timestamp + 1 hours))));
            assertEq(w.balance, 0);
            assertGt(IERC20(coin).balanceOf(w), 0, "bought anyway");
            assertEq(usdcA.balanceOf(address(x)), 0);
            assertEq(address(x).balance, 0);
        }
        // an impossible minimum: the dollars go to the user here instead
        address v = address(0xC0FFEE02);
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 10 * D,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(v, coin, type(uint256).max, 0, block.timestamp + 1 hours))));
        assertEq(usdcA.balanceOf(v), 10 * D, "refunded in full");
        assertEq(IERC20(coin).balanceOf(v), 0);
        // nobody can call the swap step
        vm.expectRevert(RaceCrossEth.OnlyPoolManager.selector);
        x.unlockCallback("");
    }

    /// Supply only goes down, whatever wins.
    function testFuzz_supplyNeverGrows(uint96 ethIn, uint96 usdIn) public {
        uint256 e = bound(uint256(ethIn), 0.001 ether, 20 ether);
        uint256 u = bound(uint256(usdIn), 1 * D, 50_000 * D);
        address coin = _launchBoth(5 * D, 5 * D, 0);
        _buyEth(coin, alice, e);
        _buyUsd(coin, bob, u);
        vm.warp(block.timestamp + 301);
        _endRace();
        bool aWon = _stateA(coin) == RaceBuilderEth.State.Won;
        assertEq(aWon, _stateB(coinB) == RaceBuilder.State.Lost);
        if (aWon) consB.forward(_coinId());
        else if (consA.pendingPool(_coinId()) > 0) consA.forward(_coinId());
        assertLe(IERC20(coin).totalSupply() + IERC20(coinB).totalSupply(), SUPPLY);
        assertEq(address(eb).balance, eb.ethReserved(), "builder holds only reserved ETH");
        assertEq(usdcA.balanceOf(address(eb)), eb.dollarsReserved(), "builder holds only reserved USDC");
    }
}

/// Chain A all local: Uniswap v4 deployed here, a deep $2,500 ETH/USDC pool, a mock feed.
contract RaceEthFlowTest is EthRaceBase {
    int256 constant ETH_USD = 2_500e8;
    MockFeed mfeed;

    function _setupChainA() internal override {
        vm.warp(1_800_000_000);
        permit2 = IAllowanceTransfer(deployPermit2());
        (pmA, posmA) = _v4();
        USD6 u = new USD6();
        usdcA = IERC20(address(u));
        minterA = IMintBurn(address(u));
        mfeed = new MockFeed();
        mfeed.set(ETH_USD, block.timestamp);
        feed = mfeed;
        dollarKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(u)), 500, 10, IHooks(address(0)));
        // the deep dollar pool: $2,500 per ETH, 1,000 ETH + $2.5M
        pmA.initialize(dollarKey, _ratioToSqrtX96(1 ether, 2_500 * D));
        EthDesk d = new EthDesk(pmA);
        u.mint(address(this), 10_000_000 * D);
        u.approve(address(d), type(uint256).max);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            _ratioToSqrtX96(1 ether, 2_500 * D),
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(10)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(10)),
            1_000 ether,
            2_500_000 * D
        );
        vm.deal(address(this), 2_000 ether);
        d.addFullRange{value: 1_100 ether}(dollarKey, liq);
    }

    function _freshFeed() internal override { mfeed.set(ETH_USD, block.timestamp); }
    function _maxFeedAge() internal pure override returns (uint256) { return 1 hours; }
    function _bigUsdc() internal pure override returns (uint256) { return 2_000_000 * D; }
    function _bigEth() internal pure override returns (uint256) { return 900 ether; }
}
