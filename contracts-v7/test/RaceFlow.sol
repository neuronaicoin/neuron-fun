// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

import {OmniHub} from "../src/omni/OmniHub.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../src/omni/ConsolidatorV6.sol";
import {OmniCoinDeployer} from "../src/omni/OmniDeployers.sol";
import {LaunchCoin} from "../src/omni/LaunchCoin.sol";
import {RaceBuilder} from "../src/race/RaceBuilder.sol";
import {RaceLaunchHook} from "../src/race/RaceLaunchHook.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {RaceSeat} from "../src/race/RaceSeat.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../src/usd/UsdPoolRouter.sol";

contract USD6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function burn(address from, uint256 a) external { _burn(from, a); }
}

/// An outside app trading straight in a pool (like GMGN or an aggregator).
contract Swapper is IUnlockCallback {
    IPoolManager public immutable pm;
    constructor(IPoolManager pm_) { pm = pm_; }

    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) external returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(msg.sender, key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (address payer, PoolKey memory key, bool z, uint256 amountIn) = abi.decode(data, (address, PoolKey, bool, uint256));
        BalanceDelta d = pm.swap(key, SwapParams({zeroForOne: z, amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), "");
        (Currency inC, Currency outC) = z ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 inD = z ? d.amount0() : d.amount1();
        int128 outD = z ? d.amount1() : d.amount0();
        uint256 pay = uint256(uint128(-inD));
        uint256 out = uint256(uint128(outD));
        pm.sync(inC);
        IERC20(Currency.unwrap(inC)).transferFrom(payer, address(pm), pay);
        pm.settle();
        pm.take(outC, payer, out);
        return abi.encode(out);
    }
}

/// Dollar bridge stand-in: what leaves one chain's consolidator arrives at the other
/// chain's builder (as Across / the OFT dollar bridge do on the real chains).
contract MockDollarBridge is IUsdcBridge {
    USD6 public immutable usdc;
    MockDollarBridge public peer;
    address public receiver; // this chain's builder
    constructor(USD6 usdc_) { usdc = usdc_; }
    function link(MockDollarBridge peer_, address receiver_) external { peer = peer_; receiver = receiver_; }
    function quote(uint32, uint256) external pure returns (uint256) { return 0; }
    function send(uint32, bytes32 coin, uint256 amount, bool buyback, address) external payable {
        usdc.transferFrom(msg.sender, address(this), amount);
        usdc.burn(address(this), amount);
        peer.arrive(coin, amount, buyback);
    }
    function arrive(bytes32 coin, uint256 amount, bool buyback) external {
        require(msg.sender == address(peer), "peer");
        usdc.mint(receiver, amount);
        RaceBuilder(receiver).receiveConsolidated(coin, amount, buyback);
    }
}

abstract contract RaceFlow is Test, DeployPermit2 {
    uint32 constant A = 40_001; // coordinator chain
    uint32 constant B = 40_002;
    uint256 constant D = 1e6;
    uint256 constant START_MC = 3_000 * D;
    uint256 constant SUPPLY = 1_000_000_000 ether;

    struct Net {
        uint32 eid;
        IPoolManager pm;
        IPositionManager posm;
        USD6 usdc;
        MockLzEndpoint ep;
        OmniHub hub;
        RaceBuilder builder;
        RaceFactory factory;
        ConsolidatorV6 cons;
        MockDollarBridge bridge;
        Swapper swapper;
    }

    IAllowanceTransfer permit2;
    Net a;
    Net b;
    address treasury = address(0x7EA5);
    address keeper = address(0x6EE9);
    address creator = address(0xC4EA);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    /// where each chain's dollar token lives (decides the token order in the pools)
    function _usdcAt(uint32 eid) internal virtual returns (address);

    /// Uniswap v4 for a chain: a fresh local deployment here; fork tests use the real one.
    function _v4(uint32) internal virtual returns (IPoolManager pm, IPositionManager posm) {
        pm = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        posm = IPositionManager(deployCode("out/PositionManager.sol/PositionManager.json",
            abi.encode(pm, permit2, uint256(300_000), IPositionDescriptor(address(0)), IWETH9(address(0)))));
    }

    /// false when the test uses a chain's real dollar (USDC / USDG) instead of a test one
    function _deployDollar() internal virtual returns (bool) {
        return true;
    }

    function _fund(Net memory c, address who, uint256 amount) internal virtual {
        c.usdc.mint(who, amount);
    }

    function _permit2() internal virtual returns (address) {
        return deployPermit2();
    }

    function _mineSalt(address deployer, bytes memory initCode) internal pure returns (bytes32) {
        bytes32 h = keccak256(initCode);
        uint160 want = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        for (uint256 i; i < 1_000_000; ++i) {
            address x = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, bytes32(i), h)))));
            if (uint160(x) & Hooks.ALL_HOOK_MASK == want) return bytes32(i);
        }
        revert("no salt");
    }

    function _chain(uint32 eid) internal returns (Net memory c) {
        c.eid = eid;
        (c.pm, c.posm) = _v4(eid);
        address at = _usdcAt(eid);
        if (_deployDollar()) deployCodeTo("RaceFlow.sol:USD6", at);
        c.usdc = USD6(at);
        c.ep = new MockLzEndpoint(eid);
        c.hub = new OmniHub(address(c.ep), address(this), A, eid);
        c.bridge = new MockDollarBridge(c.usdc);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 salt = _mineSalt(predicted, abi.encodePacked(type(RaceLaunchHook).creationCode, abi.encode(address(c.pm), predicted)));
        c.builder = new RaceBuilder(c.pm, c.posm, permit2, IERC20(address(c.usdc)), treasury, salt);
        require(address(c.builder) == predicted, "builder address");

        c.cons = new ConsolidatorV6(IERC20(address(c.usdc)), IHubLocal(address(c.hub)), IUsdcBridge(address(c.bridge)));
        address factoryAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        OmniCoinDeployer coinDeployer = new OmniCoinDeployer(factoryAt);
        c.factory = new RaceFactory(address(this), ILayerZeroEndpointV2(address(c.ep)), eid, IERC20(address(c.usdc)),
            address(c.hub), address(c.builder), treasury, 1, coinDeployer, START_MC, 5 * D, 10);
        require(address(c.factory) == factoryAt, "factory address");
        c.builder.bind(address(c.factory), address(c.cons), address(c.bridge));
        c.hub.setFactory(address(c.factory));
        c.hub.setKeeper(keeper);
        c.factory.setLaunchesOpen(true);
        c.swapper = new Swapper(c.pm);
    }

    function _route() internal pure returns (RaceFactory.Route memory r) {
        address[] memory dvns = new address[](1);
        dvns[0] = address(0xD1);
        r.sendLib = address(0x5E);
        r.receiveLib = address(0x4E);
        r.executorConfig = "";
        r.ulnConfig = abi.encode(RaceFactory.UlnConfig(1, 1, 0, 0, dvns, new address[](0)));
    }

    function setUp() public {
        permit2 = IAllowanceTransfer(_permit2());
        a = _chain(A);
        b = _chain(B);
        a.hub.setPeer(B, bytes32(uint256(uint160(address(b.hub)))));
        b.hub.setPeer(A, bytes32(uint256(uint160(address(a.hub)))));
        a.factory.setRoute(B, _route());
        b.factory.setRoute(A, _route());
        a.bridge.link(b.bridge, address(a.builder));
        b.bridge.link(a.bridge, address(b.builder));
        for (uint256 i; i < 2; ++i) {
            Net memory c = i == 0 ? a : b;
            _fund(c, creator, 1_000 * D);
            _fund(c, alice, 100_000 * D);
            _fund(c, bob, 100_000 * D);
            vm.prank(creator);
            c.usdc.approve(address(c.factory), type(uint256).max);
            vm.prank(alice);
            c.usdc.approve(address(c.swapper), type(uint256).max);
            vm.prank(bob);
            c.usdc.approve(address(c.swapper), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _eids2() internal pure returns (uint32[] memory e) {
        e = new uint32[](2);
        e[0] = A;
        e[1] = B;
    }

    function _launch(Net memory c, uint32[] memory eids, uint256 firstBuy, uint8 feeMode) internal returns (address coin, address seat) {
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), eids, feeMode, firstBuy, 0);
        vm.prank(creator);
        (coin, seat) = c.factory.launch(l);
    }

    function _buy(Net memory c, address coin, address who, uint256 usd) internal returns (uint256 out) {
        PoolKey memory key = c.builder.poolKeyFor(coin);
        bool z = c.builder.usdcIsCurrency0(coin);
        vm.prank(who);
        out = c.swapper.swap(key, z, usd);
    }

    function _sell(Net memory c, address coin, address who, uint256 coins) internal returns (uint256 out) {
        PoolKey memory key = c.builder.poolKeyFor(coin);
        bool z = !c.builder.usdcIsCurrency0(coin);
        vm.startPrank(who);
        IERC20(coin).approve(address(c.swapper), coins);
        out = c.swapper.swap(key, z, coins);
        vm.stopPrank();
    }

    function _coinId() internal view returns (bytes32) {
        return a.factory.coinIdOf(creator, bytes32("k1"));
    }

    /// keeper ends the race on both chains, the report travels to A, A decides, verdicts travel back
    function _endRace() internal {
        bytes32 id = _coinId();
        vm.startPrank(keeper);
        a.hub.freeze(id, "");
        b.hub.freeze(id, "");
        vm.stopPrank();
        a.ep.deliver(b.ep.packetAt(b.ep.packetCount() - 1)); // B's report → A
        a.hub.finalize(id, 0, ""); // decides, settles A, sends the verdict to B
        b.ep.deliver(a.ep.packetAt(a.ep.packetCount() - 1)); // verdict → B
    }

    // ------------------------------------------------------------------ flows

    /// Launch opens a pool on each chain at the same price, with the creator's first buy.
    function _flow_launchBothChains() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        assertEq(a.factory.coinIdOf(creator, bytes32("k1")), b.factory.coinIdOf(creator, bytes32("k1")));
        (uint256 ua, uint256 coinsA) = a.builder.poolAmounts(ca);
        (uint256 ub, uint256 coinsB) = b.builder.poolAmounts(cb);
        // the creator's $5 at the 2% base fee: $4.90 lands in each pool
        assertApproxEqAbs(ua, 4_900_000, 2);
        assertApproxEqAbs(ub, 4_900_000, 2);
        assertGt(IERC20(ca).balanceOf(creator), 0);
        assertGt(IERC20(cb).balanceOf(creator), 0);
        // each chain holds half of the supply, nothing more
        assertLe(IERC20(ca).totalSupply(), SUPPLY / 2);
        assertLe(IERC20(cb).totalSupply(), SUPPLY / 2);
        assertGt(coinsA, (SUPPLY / 2) * 99 / 100);
        assertGt(coinsB, (SUPPLY / 2) * 99 / 100);
    }

    /// The launch fee: a buy in the first second pays ~30%, the creator 2%.
    function _flow_launchFee() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        uint256 t0 = IERC20(address(a.usdc)).balanceOf(treasury);
        _buy(a, ca, alice, 100 * D);
        a.builder.collectFees(ca);
        uint256 toTreasury = IERC20(address(a.usdc)).balanceOf(treasury) - t0;
        // ~30% fee on $100 (and 2% on the creator's $5), 70% of it to the treasury
        assertApproxEqRel(toTreasury, (30 * D + 10 * D / 100) * 70 / 100, 0.02e18);
    }

    /// Nobody can report before the five minutes are over.
    function _flow_noEarlyEnd() internal {
        _launch(a, _eids2(), 5 * D, 0);
        _launch(b, _eids2(), 5 * D, 0);
        vm.warp(block.timestamp + 299);
        bytes32 id = _coinId();
        vm.prank(keeper);
        vm.expectRevert(RaceBuilder.RaceNotOver.selector);
        a.hub.freeze(id, "");
    }

    /// The full race: B loses, its pool is emptied once and closed, its dollars arrive on A.
    function _flow_fullRace() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 300 * D);
        _buy(b, cb, bob, 100 * D);
        vm.warp(block.timestamp + 301);
        _buy(a, ca, alice, 50 * D); // after the launch fee window

        (uint256 usdA0,) = a.builder.poolAmounts(ca);
        (uint256 usdB0,) = b.builder.poolAmounts(cb);
        assertGt(usdA0, usdB0, "A leads");
        uint256 supplyB0 = IERC20(cb).totalSupply();
        uint256 tB0 = b.usdc.balanceOf(treasury);

        _endRace();

        // B lost: pool closed, nothing left in it, unsold coins burned, 2% fee taken
        (RaceBuilder.State stA) = _state(a, ca);
        (RaceBuilder.State stB) = _state(b, cb);
        assertEq(uint8(stA), uint8(RaceBuilder.State.Won));
        assertEq(uint8(stB), uint8(RaceBuilder.State.Lost));
        (uint256 usdB1, uint256 coinsB1) = b.builder.poolAmounts(cb);
        assertEq(usdB1, 0);
        assertEq(coinsB1, 0);
        assertLt(IERC20(cb).totalSupply(), supplyB0 / 2, "unsold coins burned");
        // the treasury got its 70% of B's pool fees plus the 2% graduation fee on the pool money
        assertGt(b.usdc.balanceOf(treasury) - tB0, (usdB0 * 2) / 100);
        // what waits to cross is the pool money minus the 2% graduation fee
        uint256 pending = b.cons.pendingPool(_coinId());
        assertApproxEqAbs(pending, (usdB0 * 98) / 100, 2);

        // B's pool refuses every swap from now on
        PoolKey memory kb = b.builder.poolKeyFor(cb);
        bool zb = b.builder.usdcIsCurrency0(cb);
        vm.prank(bob);
        vm.expectRevert();
        b.swapper.swap(kb, zb, 10 * D);

        // the money travels: B's consolidator → bridge → A's builder deepens A's pool
        uint256 extraBefore = a.builder.extraPositions(ca).length;
        b.cons.forward(_coinId());
        assertEq(b.cons.pendingPool(_coinId()), 0);
        assertEq(a.builder.extraPositions(ca).length, extraBefore + 1, "A's pool got deeper");

        // A keeps trading, both ways, and selling now uses the extra dollars
        uint256 got = _buy(a, ca, bob, 20 * D);
        assertGt(got, 0);
        uint256 back = _sell(a, ca, alice, IERC20(ca).balanceOf(alice));
        assertGt(back, 0);

        // supply never grows: A + B together stay under 1B
        assertLe(IERC20(ca).totalSupply() + IERC20(cb).totalSupply(), SUPPLY);
    }

    /// Ties and quiet races: the creator's first buy is always there, so a race always graduates.
    function _flow_quietRace() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 8 * D, 0); // bigger first buy on B
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_state(b, cb)), uint8(RaceBuilder.State.Won), "bigger first buy wins");
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Lost));
    }

    /// The hand-over runs once: a second settle is refused; only the seat can settle.
    function _flow_settleOnce() internal {
        (address ca, address seatA) = _launch(a, _eids2(), 5 * D, 0);
        _launch(b, _eids2(), 5 * D, 0);
        vm.prank(alice);
        vm.expectRevert(RaceBuilder.NotSeat.selector);
        a.builder.settle(ca, B, false);
        vm.prank(alice);
        vm.expectRevert(RaceSeat.NotHub.selector);
        RaceSeat(seatA).settle(B, false, 0, 0);
        vm.warp(block.timestamp + 301);
        _endRace();
        vm.prank(seatA);
        vm.expectRevert(RaceBuilder.RaceDone.selector);
        a.builder.settle(ca, B, false);
    }

    /// Only the bridge can deliver dollars; only the builder can close a pool.
    function _flow_accessRules() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        bytes32 id = _coinId();
        vm.prank(alice);
        vm.expectRevert(RaceBuilder.NotBridge.selector);
        a.builder.receiveConsolidated(id, 1, false);
        PoolKey memory k = a.builder.poolKeyFor(ca);
        RaceLaunchHook g = a.builder.hook();
        vm.prank(alice);
        vm.expectRevert(RaceLaunchHook.OnlyRaceBuilder.selector);
        g.shutPool(k);
    }

    /// The first buy must be at least $5.
    function _flow_minFirstBuy() internal {
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids2(), 0, 4 * D, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RaceFactory.FirstBuyTooSmall.selector, 5 * D));
        a.factory.launch(l);
    }

    /// A coin on one chain: no race to wait for, it "wins" at once after five minutes.
    function _flow_singleChain() internal {
        uint32[] memory e = new uint32[](1);
        e[0] = A;
        (address ca,) = _launch(a, e, 5 * D, 0);
        vm.warp(block.timestamp + 301);
        bytes32 id = _coinId();
        vm.prank(keeper);
        a.hub.freeze(id, "");
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Won));
        assertGt(_buy(a, ca, alice, 10 * D), 0);
    }

    /// Buyback & burn mode: the coin's 30% buys and burns the coin.
    function _flow_buybackMode() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 1);
        _buy(a, ca, alice, 200 * D);
        a.builder.collectFees(ca);
        assertGt(a.builder.buybackFunds(ca), 0);
        uint256 s0 = IERC20(ca).totalSupply();
        a.builder.buyback(ca);
        assertLt(IERC20(ca).totalSupply(), s0, "burned");
    }

    /// The site's router (the reviewed v6 USD pool router, unchanged) trades in race pools.
    function _flow_router() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        UsdPoolRouter ra = new UsdPoolRouter(a.pm, IUsdGraduatedPools(address(a.builder)));
        UsdPoolRouter rb = new UsdPoolRouter(b.pm, IUsdGraduatedPools(address(b.builder)));
        vm.startPrank(alice);
        a.usdc.approve(address(ra), type(uint256).max);
        b.usdc.approve(address(rb), type(uint256).max);
        uint256 got = ra.buy(ca, 100 * D, 1, alice, block.timestamp);
        assertGt(got, 0);
        rb.buy(cb, 20 * D, 1, alice, block.timestamp);
        IERC20(ca).approve(address(ra), type(uint256).max);
        uint256 back = ra.sell(ca, got / 2, 1, alice, block.timestamp);
        assertGt(back, 0);
        vm.stopPrank();
        vm.warp(block.timestamp + 301);
        _endRace();
        // the losing chain's pool is refused by the router (and by the pool itself)
        vm.prank(alice);
        vm.expectRevert(UsdPoolRouter.NotGraduated.selector);
        rb.buy(cb, 10 * D, 1, alice, block.timestamp);
        // the winner keeps trading through the router
        vm.prank(alice);
        assertGt(ra.buy(ca, 10 * D, 1, alice, block.timestamp), 0);
    }

    /// After the race, nothing more can be taken from a losing chain's builder for that coin.
    function _flow_lostIsFinal() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 50 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        vm.expectRevert(RaceBuilder.RaceDone.selector);
        b.builder.collectFees(cb);
        vm.expectRevert(RaceBuilder.NotOpen.selector);
        b.builder.buyback(cb);
        // money can't be delivered for a lost coin on its own chain either
        bytes32 id = _coinId();
        b.usdc.mint(address(b.builder), 1 * D);
        vm.prank(address(b.bridge));
        vm.expectRevert(RaceBuilder.NotOpen.selector);
        b.builder.receiveConsolidated(id, 1 * D, false);
        // and the winner's builder holds no way to remove its liquidity: its positions stay
        uint256 posA = _posId(a, ca);
        assertGt(a.posm.getPositionLiquidity(posA), 0);
    }

    /// Buyback money arriving on the winner funds buybacks (never the pool, never a wallet).
    function _flow_buybackArrives() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 1);
        _launch(b, _eids2(), 5 * D, 1);
        vm.warp(block.timestamp + 301);
        _endRace();
        bytes32 id = _coinId();
        a.usdc.mint(address(a.builder), 7 * D);
        vm.prank(address(a.bridge));
        a.builder.receiveConsolidated(id, 7 * D, true);
        assertEq(a.builder.buybackFunds(ca), 7 * D);
    }

    /// Dollars that arrive after the winner's price fell are still placed safely below the price.
    function _flow_deepenAfterDrop() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        uint256 coins = _buy(a, ca, alice, 400 * D);
        _buy(b, cb, bob, 50 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        _sell(a, ca, alice, coins); // price drops on the winner before the money lands
        b.cons.forward(_coinId());
        assertEq(a.builder.extraPositions(ca).length, 1);
        // sells now draw on the extra dollars: a holder can still sell
        uint256 c2 = _buy(a, ca, bob, 30 * D);
        assertGt(_sell(a, ca, bob, c2), 0);
    }

    /// Random trading on both chains, then the race: the total supply never exceeds 1B and
    /// every dollar is accounted for (wallets + treasury + pools + in transit), on each chain.
    function _flow_fuzzConservation(uint256 seed) internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, uint8(seed % 2));
        (address cb,) = _launch(b, _eids2(), 5 * D, uint8(seed % 2));
        uint256 totalA = a.usdc.totalSupply();
        uint256 totalB = b.usdc.totalSupply();
        for (uint256 i; i < 12; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            Net memory c = r % 2 == 0 ? a : b;
            address coin = r % 2 == 0 ? ca : cb;
            address who = (r >> 8) % 2 == 0 ? alice : bob;
            if ((r >> 16) % 3 == 0 && IERC20(coin).balanceOf(who) > 0) {
                _sell(c, coin, who, (IERC20(coin).balanceOf(who) * ((r >> 24) % 100 + 1)) / 100);
            } else {
                _buy(c, coin, who, ((r >> 32) % 2_000 + 1) * D / 4);
            }
            if (i == 5) vm.warp(block.timestamp + 120);
        }
        vm.warp(block.timestamp + 301);
        _endRace();
        bytes32 id = _coinId();
        // whichever chain lost hands its money over; forward it if there is some
        if (b.cons.pendingPool(id) > 0) b.cons.forward(id);
        if (a.cons.pendingPool(id) > 0) a.cons.forward(id);
        // supply: both chains together never more than 1B (burns only make it smaller)
        assertLe(IERC20(ca).totalSupply() + IERC20(cb).totalSupply(), SUPPLY);
        // dollars: the bridge burns on one side and mints on the other, so together they are conserved
        assertEq(a.usdc.totalSupply() + b.usdc.totalSupply(), totalA + totalB, "no dollar created or lost");
        // nothing stuck in the consolidators
        assertEq(a.cons.pendingPool(id) + b.cons.pendingPool(id), 0);
        // the loser's builder keeps no dollars for this coin
        (,,,,, RaceBuilder.State sa,) = a.builder.races(ca);
        Net memory loser = sa == RaceBuilder.State.Lost ? a : b;
        assertEq(loser.usdc.balanceOf(address(loser.builder)), loser.builder.dollarsReserved());
    }

    function _posId(Net memory c, address coin) internal view returns (uint256 id) {
        (id,,,,,,) = c.builder.races(coin);
    }

    function _state(Net memory c, address coin) internal view returns (RaceBuilder.State st) {
        (,,,,, st,) = c.builder.races(coin);
    }
}

/// dollars sort before the coins (USDC is currency0)
contract RaceLowTest is RaceFlow {
    function _usdcAt(uint32 eid) internal pure override returns (address) { return address(uint160(0x1000 + eid)); }
    function test_launchBothChains() public { _flow_launchBothChains(); }
    function test_launchFee() public { _flow_launchFee(); }
    function test_noEarlyEnd() public { _flow_noEarlyEnd(); }
    function test_fullRace() public { _flow_fullRace(); }
    function test_quietRace() public { _flow_quietRace(); }
    function test_settleOnce() public { _flow_settleOnce(); }
    function test_accessRules() public { _flow_accessRules(); }
    function test_minFirstBuy() public { _flow_minFirstBuy(); }
    function test_singleChain() public { _flow_singleChain(); }
    function test_buybackMode() public { _flow_buybackMode(); }
    function test_router() public { _flow_router(); }
    function test_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_buybackArrives() public { _flow_buybackArrives(); }
    function test_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function testFuzz_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
}

/// dollars sort after the coins (USDC is currency1)
contract RaceHighTest is RaceFlow {
    function _usdcAt(uint32 eid) internal pure override returns (address) { return address(uint160(type(uint160).max - eid)); }
    function test_launchBothChains() public { _flow_launchBothChains(); }
    function test_launchFee() public { _flow_launchFee(); }
    function test_noEarlyEnd() public { _flow_noEarlyEnd(); }
    function test_fullRace() public { _flow_fullRace(); }
    function test_quietRace() public { _flow_quietRace(); }
    function test_settleOnce() public { _flow_settleOnce(); }
    function test_accessRules() public { _flow_accessRules(); }
    function test_minFirstBuy() public { _flow_minFirstBuy(); }
    function test_singleChain() public { _flow_singleChain(); }
    function test_buybackMode() public { _flow_buybackMode(); }
    function test_router() public { _flow_router(); }
    function test_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_buybackArrives() public { _flow_buybackArrives(); }
    function test_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function testFuzz_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
}
