// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
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
import {RaceCross, RaceCrossUsdc, IRaceRouter} from "../src/race/RaceCross.sol";
import {CrossSpoke, ICrossMinter} from "./CrossSpoke.sol";

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
    using PoolIdLibrary for PoolKey;

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

    /// The launch fee: a buy in the first second pays ~10%, the creator 2%.
    function _flow_launchFee() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        uint256 t0 = IERC20(address(a.usdc)).balanceOf(treasury);
        _buy(a, ca, alice, 100 * D);
        a.builder.collectFees(ca);
        uint256 toTreasury = IERC20(address(a.usdc)).balanceOf(treasury) - t0;
        // ~10% fee on $100 (and 2% on the creator's $5), 70% of it to the treasury
        assertApproxEqRel(toTreasury, (10 * D + 10 * D / 100) * 70 / 100, 0.02e18);
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

    /// The race fee: the creator pays it on each chain, straight to `raceFeeTo` (the treasury
    /// until set, sasa's keeper on mainnet), on top of the first buy; nothing else changes.
    /// Owner only, never above $2.
    function _flow_raceFee() internal {
        assertEq(a.factory.raceFee(), 0, "off until set");
        assertEq(a.factory.maxRaceFee(), 2 * D, "cap is $2 in this chain's dollar");
        vm.expectRevert(RaceFactory.BadConfig.selector);
        a.factory.setRaceFee(2 * D + 1);
        vm.prank(alice);
        vm.expectRevert();
        a.factory.setRaceFee(D / 2);
        vm.expectEmit(address(a.factory));
        emit RaceFactory.RaceFeeSet(D / 2);
        a.factory.setRaceFee(D / 2);

        // chain A charges $0.50, chain B nothing: the same launch on both
        uint256 cA = a.usdc.balanceOf(creator);
        uint256 cB = b.usdc.balanceOf(creator);
        uint256 tA = a.usdc.balanceOf(treasury);
        uint256 tB = b.usdc.balanceOf(treasury);
        _launch(a, _eids2(), 5 * D, 0);
        _launch(b, _eids2(), 5 * D, 0);
        assertEq(cA - a.usdc.balanceOf(creator), 5 * D + D / 2, "creator pays first buy + race fee");
        assertEq(cB - b.usdc.balanceOf(creator), 5 * D, "no fee where none is set");
        assertEq(a.usdc.balanceOf(treasury) - tA, D / 2 + (b.usdc.balanceOf(treasury) - tB), "the fee went to the treasury");

        // without enough allowance for the fee the launch doesn't go through
        a.factory.setRaceFee(2 * D);
        vm.prank(creator);
        a.usdc.approve(address(a.factory), 5 * D + D);
        RaceFactory.Launch memory l = RaceFactory.Launch("Two", "TWO", "", "", bytes32("k2"), _eids2(), 0, 5 * D, 0);
        vm.prank(creator);
        vm.expectRevert();
        a.factory.launch(l);

        // the fee can go to the keeper instead (owner only, never to nobody)
        assertEq(a.factory.raceFeeTo(), treasury, "treasury until set");
        vm.prank(alice);
        vm.expectRevert();
        a.factory.setRaceFeeTo(keeper);
        vm.expectRevert(RaceFactory.BadConfig.selector);
        a.factory.setRaceFeeTo(address(0));
        vm.expectEmit(address(a.factory));
        emit RaceFactory.RaceFeeToSet(keeper);
        a.factory.setRaceFeeTo(keeper);
        assertEq(a.factory.raceFeeTo(), keeper);
        a.factory.setRaceFee(D / 2);
        vm.prank(creator);
        a.usdc.approve(address(a.factory), type(uint256).max);
        uint256 k0 = a.usdc.balanceOf(keeper);
        uint256 t0 = a.usdc.balanceOf(treasury);
        l = RaceFactory.Launch("Three", "THREE", "", "", bytes32("k3"), _eids2(), 0, 5 * D, 0);
        vm.prank(creator);
        a.factory.launch(l);
        assertEq(a.usdc.balanceOf(keeper) - k0, D / 2, "the fee went to the keeper");
        assertEq(a.usdc.balanceOf(treasury), t0, "not to the treasury");
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
        // only sasa's keeper runs buybacks, with a minimum
        vm.prank(alice);
        vm.expectRevert(RaceBuilder.NotKeeper.selector);
        a.builder.buyback(ca, 1);
        vm.prank(keeper);
        vm.expectPartialRevert(RaceBuilder.Slippage.selector); // too high a minimum: nothing happens
        a.builder.buyback(ca, type(uint256).max);
        vm.prank(keeper);
        a.builder.buyback(ca, 1);
        assertLt(IERC20(ca).totalSupply(), s0, "burned");
    }

    /// The site's router (the reviewed v6 USD pool router, unchanged) trades in race pools.
    /// Arc-like chain (dollar pools, gas paid in dollars): a buy from Base leaves a little of the
    /// dollars as gas and buys the rest; selling sends the dollars home; the losing chain refunds.
    function _flow_cross() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        UsdPoolRouter ra = new UsdPoolRouter(a.pm, IUsdGraduatedPools(address(a.builder)));
        UsdPoolRouter rb = new UsdPoolRouter(b.pm, IUsdGraduatedPools(address(b.builder)));
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossUsdc xa = new RaceCrossUsdc(spoke, IERC20(address(a.usdc)), IRaceRouter(address(ra)), a.factory, 8453, IERC20(address(0xBA5E)), 6, D / 10);
        RaceCrossUsdc xb = new RaceCrossUsdc(spoke, IERC20(address(b.usdc)), IRaceRouter(address(rb)), b.factory, 8453, IERC20(address(0xBA5E)), 6, D / 10);
        vm.warp(block.timestamp + 130); // the opening fee is down to 2%
        address u = address(0xC0FFEE01);
        spoke.fill(address(a.usdc), ICrossMinter(address(a.usdc)), address(xa), 20 * D,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(u, ca, 1, 30 * D / 100, block.timestamp + 1 hours))));
        assertEq(a.usdc.balanceOf(u), 30 * D / 100, "30 cents left as gas");
        uint256 coins = IERC20(ca).balanceOf(u);
        assertGt(coins, 0, "coins delivered");
        assertEq(a.usdc.balanceOf(address(xa)), 0);
        vm.startPrank(u);
        IERC20(ca).approve(address(xa), coins);
        uint256 got = xa.sellAndSendHome(ca, coins, 1, D / 100, block.timestamp);
        vm.stopPrank();
        assertGt(got, 18 * D);
        assertEq(spoke.lastOutput(), got - D / 100);
        assertEq(spoke.lastDepositor(), u);
        // after the race the losing chain's pool refuses buys: the dollars come back instead
        vm.warp(block.timestamp + 200);
        _endRace();
        address v = address(0xC0FFEE02);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 10 * D,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(v, cb, 1, 0, block.timestamp + 1 hours))));
        assertEq(b.usdc.balanceOf(v), 10 * D, "refunded in full on the losing chain");
        assertEq(IERC20(cb).balanceOf(v), 0);
    }


    function _signLaunch(RaceCross x, uint256 pk, RaceFactory.Launch memory l, uint256 gasUsd, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, x.launchDigest(vm.addr(pk), l, gasUsd, deadline));
        return abi.encodePacked(r, sg, v);
    }

    function _launchMsg(RaceCross x, uint256 pk, RaceFactory.Launch memory l, uint256 gasUsd, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(vm.addr(pk), l, gasUsd, deadline, _signLaunch(x, pk, l, gasUsd, deadline))));
    }

    /// A sasa account with its dollars on Base launches on chain A itself and on chain B through
    /// Across + RaceCross: same coin id, creator, fees and first-buy coins as a direct launch;
    /// only the user's own signature can launch as the user; a launch that can't happen is never
    /// filled (Across returns the dollars on Base), whatever gas a relayer gives it.
    function _flow_crossLaunch() internal {
        uint256 pk = 0xA11CE5EC2E7;
        creator = vm.addr(pk);
        CrossSpoke spoke = new CrossSpoke();
        UsdPoolRouter rb = new UsdPoolRouter(b.pm, IUsdGraduatedPools(address(b.builder)));
        RaceCrossUsdc xb = new RaceCrossUsdc(spoke, IERC20(address(b.usdc)), IRaceRouter(address(rb)), b.factory, 8453, IERC20(address(0xBA5E)), 6, D / 10);
        b.factory.setRaceFee(D / 2);

        // only the owner sets the launcher; nobody else can launch for someone
        vm.prank(alice);
        vm.expectRevert();
        b.factory.setLauncher(address(xb));
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids2(), 0, 5 * D, 0);
        vm.prank(alice);
        vm.expectRevert(RaceFactory.NotLauncher.selector);
        b.factory.launchFor(creator, l);
        uint256 dl = vm.getBlockTimestamp() + 10 minutes; // (via-ir may re-read block.timestamp later)
        bytes memory good = _launchMsg(xb, pk, l, 30 * D / 100, dl);
        // not the launcher yet: not filled
        vm.expectRevert(RaceFactory.NotLauncher.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, good);

        vm.expectEmit(address(b.factory));
        emit RaceFactory.LauncherSet(address(xb));
        b.factory.setLauncher(address(xb));

        // set once: never pointed somewhere else, only switched off for good
        vm.expectRevert(RaceFactory.LauncherFixed.selector);
        b.factory.setLauncher(alice);
        assertEq(b.factory.launcher(), address(xb));

        // a forged order (someone else's signature) is refused
        bytes memory forged = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(creator, l, 0, dl, _signLaunch(xb, 0xBAD, l, 0, dl))));
        vm.expectRevert(RaceCross.BadSignature.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, forged);
        // a signature over different launch details (or another gas amount) is refused too
        RaceFactory.Launch memory other = RaceFactory.Launch("Evil Cat", "EVIL", "", "", bytes32("k1"), _eids2(), 0, 5 * D, 0);
        bytes memory swapped = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(creator, other, 0, dl, _signLaunch(xb, pk, l, 0, dl))));
        vm.expectRevert(RaceCross.BadSignature.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, swapped);
        swapped = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(creator, l, D / 2, dl, _signLaunch(xb, pk, l, 0, dl))));
        vm.expectRevert(RaceCross.BadSignature.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, swapped);
        // an unknown message kind is refused
        vm.expectRevert(RaceCross.UnknownKind.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, abi.encode(uint8(7), bytes("")));
        // too little money for first buy + race fee (+ the gas asked for): not filled
        vm.expectRevert(RaceCross.NotEnough.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 5 * D + D / 2, good);
        // a relayer giving too little gas can't turn the launch into anything: the fill just fails
        for (uint256 gl = 500_000; gl <= 4_000_000; gl += 250_000) {
            vm.expectRevert();
            spoke.fill{gas: gl}(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, good);
        }
        assertEq(b.factory.coinAddress(creator, bytes32("k1")).code.length, 0, "nothing launched");
        assertEq(b.usdc.balanceOf(creator), 0, "nothing delivered either");

        // the creator launches on A directly (from Base, say) ...
        _fund(a, creator, 10 * D);
        vm.prank(creator);
        a.usdc.approve(address(a.factory), type(uint256).max);
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        // ... and on B through Across: $6.00 = 30c gas + 50c race fee + $5 first buy + 20c back
        uint256 tB = b.usdc.balanceOf(treasury);
        uint256 g0 = gasleft();
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, good);
        emit log_named_uint("cross launch fill gas", g0 - gasleft());
        assertLt(g0 - gasleft(), 7_000_000, "a launch fill fits easily in a block");
        address cb = b.factory.coinAddress(creator, bytes32("k1"));
        // the same coin id as the direct launch (the address is the same where the factory is, as on mainnet)
        assertGt(cb.code.length, 0, "launched for the creator");
        assertGt(ca.code.length, 0);
        assertEq(b.factory.coinIdOf(creator, bytes32("k1")), a.factory.coinIdOf(creator, bytes32("k1")));
        assertGt(IERC20(cb).balanceOf(creator), 0, "first-buy coins are the creator's");
        assertEq(IERC20(cb).balanceOf(address(xb)), 0);
        assertEq(b.usdc.balanceOf(creator), 30 * D / 100 + 20 * D / 100, "gas + change");
        // the treasury gets the race fee (plus its usual share of the first buy's pool fee)
        assertGe(b.usdc.balanceOf(treasury) - tB, D / 2, "race fee to the treasury");
        assertLe(b.usdc.balanceOf(treasury) - tB, D / 2 + D / 10);
        assertEq(b.usdc.balanceOf(address(xb)), 0, "nothing stays in RaceCross");
        (uint256 ub,) = b.builder.poolAmounts(cb);
        assertApproxEqAbs(ub, 4_900_000, 2);

        // the same order again (replay): refused cheaply, nothing launched twice
        vm.expectRevert(RaceCross.AlreadyLaunched.selector);
        spoke.fill{gas: 1_000_000}(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, good);

        // the race runs as usual with the cross-launched chain
        vm.warp(vm.getBlockTimestamp() + 10);
        _buy(a, ca, alice, 50 * D);
        _buy(b, cb, bob, 10 * D);
        vm.warp(vm.getBlockTimestamp() + 301);
        _endRace();

        // too late: not filled
        vm.warp(dl + 1);
        RaceFactory.Launch memory l2 = RaceFactory.Launch("Two", "TWO", "", "", bytes32("k2"), _eids2(), 0, 5 * D, 0);
        bytes memory late = _launchMsg(xb, pk, l2, 0, dl);
        vm.expectRevert(RaceCross.TooLate.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, late);
        // a sasa account with EIP-7702 code here still launches with its own key's signature
        vm.etch(creator, abi.encodePacked(hex"ef0100", address(new SigRejecter())));
        RaceFactory.Launch memory l3 = RaceFactory.Launch("Three", "THR", "", "", bytes32("k3"), _eids2(), 0, 5 * D, 0);
        bytes memory m3 = _launchMsg(xb, pk, l3, 0, dl + 1 hours);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, m3);
        assertGt(b.factory.coinAddress(creator, bytes32("k3")).code.length, 0, "7702 account launched");
        vm.etch(creator, "");
        // closed launches: not filled
        b.factory.setLaunchesOpen(false);
        bytes memory closed = _launchMsg(xb, pk, l2, 0, dl + 1 hours);
        vm.expectRevert(RaceFactory.LaunchesClosed.selector);
        spoke.fill(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, closed);
        // the launcher can be switched off for good, and then never set again
        b.factory.setLauncher(address(0));
        vm.expectRevert(RaceFactory.LauncherFixed.selector);
        b.factory.setLauncher(address(xb));
    }

    /// Whatever gas the relayer gives a launch fill: either the full launch (coins, gas, change
    /// all with the user) or nothing at all.
    function _flow_crossLaunchAnyGas(uint256 gl) internal {
        gl = bound(gl, 200_000, 8_000_000);
        uint256 pk = 0xA11CE5EC2E7;
        creator = vm.addr(pk);
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossUsdc xb = new RaceCrossUsdc(spoke, IERC20(address(b.usdc)), IRaceRouter(address(1)), b.factory, 8453, IERC20(address(0xBA5E)), 6, D / 10);
        b.factory.setLauncher(address(xb));
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids2(), 0, 5 * D, 0);
        bytes memory m = _launchMsg(xb, pk, l, 30 * D / 100, vm.getBlockTimestamp() + 10 minutes);
        try spoke.fill{gas: gl}(address(b.usdc), ICrossMinter(address(b.usdc)), address(xb), 6 * D, m) {
            address coin = b.factory.coinAddress(creator, bytes32("k1"));
            assertGt(coin.code.length, 0, "launched");
            assertGt(IERC20(coin).balanceOf(creator), 0, "first-buy coins");
            assertEq(b.usdc.balanceOf(creator), D, "30c gas + 70c change (no race fee set)");
        } catch {
            assertEq(b.factory.coinAddress(creator, bytes32("k1")).code.length, 0, "nothing launched");
            assertEq(b.usdc.balanceOf(creator), 0, "nothing delivered");
        }
        assertEq(b.usdc.balanceOf(address(xb)), 0, "nothing stays in RaceCross");
    }

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
        vm.prank(keeper);
        vm.expectRevert(RaceBuilder.NotOpen.selector);
        b.builder.buyback(cb, 1);
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

    /// After the race, sasa's keeper can move holders' coins off the losing chain at once
    /// (the coin finds the keeper through its controller, the builder, and the hub).
    function _flow_keeperMovesHolders() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 100 * D);
        _buy(b, cb, bob, 20 * D);
        assertEq(b.builder.hub(), address(b.hub), "builder names its hub");
        vm.warp(block.timestamp + 301);
        _endRace();
        // B lost: bob's coins on B go to A through the keeper, within the first day
        address[] memory who = new address[](1);
        who[0] = bob;
        uint256 n0 = b.ep.packetCount();
        vm.prank(alice); // not the keeper: refused during the first day
        vm.expectRevert(LaunchCoin.MoveNotOpenYet.selector);
        LaunchCoin(cb).moveBatch(who, "");
        vm.prank(keeper);
        LaunchCoin(cb).moveBatch(who, "");
        assertLt(IERC20(cb).balanceOf(bob), 1e12, "moved off the losing chain (only bridge dust stays)");
        assertEq(b.ep.packetCount(), n0 + 1, "one cross-chain message sent");
    }

    // ------------------------------------------------------------------ the race result is fixed at the five minutes

    /// The attack the reviewers found: once the race is over, a big buy on the losing chain
    /// (made just before that chain is frozen) must not make it win. Only the money in the
    /// pool when the five minutes ended counts.
    function _flow_lateBuyCantFlipRace() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 200 * D);
        _buy(b, cb, bob, 60 * D);
        vm.warp(block.timestamp + 301); // the race is over: A leads
        // after the end: a big buy on B, and A's buyer sells most of A's money out
        _buy(b, cb, bob, 2_000 * D);
        _sell(a, ca, alice, (IERC20(ca).balanceOf(alice) * 9) / 10);
        (uint256 liveA,) = a.builder.poolAmounts(ca);
        (uint256 liveB,) = b.builder.poolAmounts(cb);
        assertGt(liveB, liveA, "live pools would say B");
        _endRace();
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Won), "A won: it led when the race ended");
        assertEq(uint8(_state(b, cb)), uint8(RaceBuilder.State.Lost));
    }

    /// The money written down is the pool exactly as the race ended (before the first late swap),
    /// written once; the hook remembers it is done; only the hook can write it.
    function _flow_raceEndRecorded() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 120 * D);
        PoolKey memory ka = a.builder.poolKeyFor(ca);
        // anyone may ask for the record, but during the race there is nothing to write
        vm.prank(alice);
        assertFalse(a.builder.recordRaceEnd(ka));

        // a swap during the race writes nothing
        vm.warp(block.timestamp + 299);
        _buy(a, ca, bob, 10 * D);
        (,, bool rec0,) = a.builder.raceEnd(ca);
        assertFalse(rec0, "nothing written during the race");

        vm.warp(block.timestamp + 1); // exactly the end
        (uint256 atEnd, uint256 coinsAtEnd) = a.builder.poolAmounts(ca);
        _buy(a, ca, bob, 500 * D);
        (uint256 m, uint256 c, bool rec,) = a.builder.raceEnd(ca);
        assertTrue(rec);
        assertEq(m, atEnd, "the pool before the late swap");
        assertEq(c, coinsAtEnd);
        assertTrue(a.builder.hook().raceEndRecorded(ka.toId()));
        // later swaps change nothing written
        _sell(a, ca, bob, IERC20(ca).balanceOf(bob) / 2);
        (uint256 m2,,,) = a.builder.raceEnd(ca);
        assertEq(m2, atEnd);

        // B had no swap after the end: its report reads the pool, which is still as it ended
        (uint256 bEnd,) = b.builder.poolAmounts(cb);
        (,, bool recB,) = b.builder.raceEnd(cb);
        assertFalse(recB);
        bytes32 id = _coinId();
        vm.recordLogs();
        vm.startPrank(keeper);
        a.hub.freeze(id, "");
        b.hub.freeze(id, "");
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RaceReported(address,uint256)");
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            address coin = address(uint160(uint256(logs[i].topics[1])));
            uint256 reported = abi.decode(logs[i].data, (uint256));
            if (logs[i].emitter == address(a.builder)) assertEq(reported, atEnd, "A reports the money at the end");
            if (logs[i].emitter == address(b.builder)) assertEq(reported, bEnd, "B reports its untouched pool");
            assertTrue(coin == ca || coin == cb);
            seen++;
        }
        assertEq(seen, 2);
    }

    /// Anyone (sasa's keeper) can write the record right at the end, before any swap: it is the
    /// pool as the race ended, and the first trader's swap after that doesn't pay for writing it.
    function _flow_anyoneRecordsAtTheEnd() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 150 * D);
        vm.warp(block.timestamp + 300);
        (uint256 atEnd,) = a.builder.poolAmounts(ca);
        PoolKey memory ka = a.builder.poolKeyFor(ca);
        vm.prank(bob);
        assertTrue(a.builder.recordRaceEnd(ka));
        (uint256 m,, bool rec,) = a.builder.raceEnd(ca);
        assertTrue(rec);
        assertEq(m, atEnd);
        // a swap now doesn't change it, and a second call changes nothing
        _buy(a, ca, bob, 900 * D);
        vm.prank(alice);
        assertTrue(a.builder.recordRaceEnd(ka));
        (uint256 m2,,,) = a.builder.raceEnd(ca);
        assertEq(m2, atEnd);
        // a key that names an unknown coin writes nothing
        PoolKey memory junk = ka;
        junk.currency0 = Currency.wrap(address(0xBEEF));
        junk.currency1 = Currency.wrap(address(0xBEEF));
        assertTrue(a.builder.recordRaceEnd(junk));
        (,, bool recJunk,) = a.builder.raceEnd(address(0xBEEF));
        assertFalse(recJunk);
    }

    /// The race itself is unchanged: money that is in the pool when the five minutes end counts,
    /// even if it came in the very last second.
    function _flow_lastSecondBuyCounts() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 200 * D);
        vm.warp(block.timestamp + 299);
        _buy(b, cb, bob, 400 * D); // one second before the end
        vm.warp(block.timestamp + 2);
        _endRace();
        assertEq(uint8(_state(b, cb)), uint8(RaceBuilder.State.Won));
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Lost));
    }

    /// The losing chain's money arrives on the winner as buy orders. Pushing the price up just
    /// before it arrives and selling into it afterwards must not pay: the money is never placed
    /// above the price the race ended at.
    function _flow_pumpBeforeArrivalGainsNothing() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 3_000 * D);
        _buy(b, cb, alice, 2_000 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Won));
        assertGt(b.cons.pendingPool(_coinId()), 1_500 * D, "B's money is on its way");

        uint256 before = a.usdc.balanceOf(bob);
        _buy(a, ca, bob, 6_000 * D); // push the price up
        b.cons.forward(_coinId()); // the money arrives and is placed
        _sell(a, ca, bob, IERC20(ca).balanceOf(bob)); // sell into it
        assertLt(a.usdc.balanceOf(bob), before, "no profit from pushing the price");
    }

    /// After the verdict the winning pool trades on normally (the record is never in the way).
    function _flow_winnerTradesAfterRecord() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 100 * D);
        vm.warp(block.timestamp + 301);
        _buy(a, ca, bob, 5 * D);
        _endRace();
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Won));
        assertGt(_buy(a, ca, bob, 5 * D), 0);
        assertGt(_sell(a, ca, bob, IERC20(ca).balanceOf(bob)), 0);
    }

    /// The coin's price in dollars, as a number that grows when the coin gets dearer.
    function _coinPrice(Net memory c, address coin) internal view returns (int256) {
        (, int24 tick,,) = StateLibrary.getSlot0(c.pm, PoolIdLibrary.toId(c.builder.poolKeyFor(coin)));
        return c.builder.usdcIsCurrency0(coin) ? -int256(tick) : int256(tick);
    }

    /// v8: the money from the losing chain lifts the winner's price and lands as full-range
    /// liquidity (counted by every screener); nothing is minted.
    function _flow_mergeRaisesPrice() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 300 * D);
        _buy(b, cb, bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_state(a, ca)), uint8(RaceBuilder.State.Won));
        uint256 supply0 = IERC20(ca).totalSupply();
        int256 p0 = _coinPrice(a, ca);
        b.cons.forward(_coinId());
        assertGt(_coinPrice(a, ca), p0, "the merge buy lifted the price");
        uint256[] memory extra = a.builder.extraPositions(ca);
        assertEq(extra.length, 1);
        (, PositionInfo info) = a.posm.getPoolAndPositionInfo(extra[0]);
        assertEq(PositionInfoLibrary.tickLower(info), TickMath.minUsableTick(200), "full range");
        assertEq(PositionInfoLibrary.tickUpper(info), TickMath.maxUsableTick(200), "full range");
        assertGt(a.posm.getPositionLiquidity(extra[0]), 0);
        assertLe(IERC20(ca).totalSupply(), supply0, "nothing minted");
        // trading goes on both ways
        uint256 got = _buy(a, ca, bob, 20 * D);
        assertGt(_sell(a, ca, bob, got), 0);
        assertGt(_sell(a, ca, alice, IERC20(ca).balanceOf(alice)), 0);
    }

    /// v8: a coin pushed more than 20% above its race-end price doesn't get the merge buy (the
    /// dollars fund buybacks instead), so pumping it before the money lands pays nothing.
    function _flow_mergeSkipsPumpedCoin() internal {
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        _buy(a, ca, alice, 300 * D);
        _buy(b, cb, bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        _buy(a, ca, bob, 600 * D); // pushes the price far above the race end
        int256 p0 = _coinPrice(a, ca);
        b.cons.forward(_coinId());
        assertEq(_coinPrice(a, ca), p0, "no merge buy on a pumped coin");
        assertEq(a.builder.extraPositions(ca).length, 0, "no position on a pumped coin");
        assertGt(a.builder.buybackFunds(ca), 0, "the money funds buybacks instead");
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
    function test_raceFee() public { _flow_raceFee(); }
    function test_cross() public { _flow_cross(); }
    function test_crossLaunch() public { _flow_crossLaunch(); }
    function testFuzz_crossLaunchAnyGas(uint256 gl) public { _flow_crossLaunchAnyGas(gl); }
    function test_singleChain() public { _flow_singleChain(); }
    function test_buybackMode() public { _flow_buybackMode(); }
    function test_router() public { _flow_router(); }
    function test_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_buybackArrives() public { _flow_buybackArrives(); }
    function test_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function testFuzz_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
    function test_keeperMovesHolders() public { _flow_keeperMovesHolders(); }
    function test_lateBuyCantFlipRace() public { _flow_lateBuyCantFlipRace(); }
    function test_raceEndRecorded() public { _flow_raceEndRecorded(); }
    function test_lastSecondBuyCounts() public { _flow_lastSecondBuyCounts(); }
    function test_winnerTradesAfterRecord() public { _flow_winnerTradesAfterRecord(); }
    function test_pumpBeforeArrivalGainsNothing() public { _flow_pumpBeforeArrivalGainsNothing(); }
    function test_anyoneRecordsAtTheEnd() public { _flow_anyoneRecordsAtTheEnd(); }
    function test_mergeRaisesPrice() public { _flow_mergeRaisesPrice(); }
    function test_mergeSkipsPumpedCoin() public { _flow_mergeSkipsPumpedCoin(); }
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
    function test_raceFee() public { _flow_raceFee(); }
    function test_cross() public { _flow_cross(); }
    function test_crossLaunch() public { _flow_crossLaunch(); }
    function testFuzz_crossLaunchAnyGas(uint256 gl) public { _flow_crossLaunchAnyGas(gl); }
    function test_singleChain() public { _flow_singleChain(); }
    function test_buybackMode() public { _flow_buybackMode(); }
    function test_router() public { _flow_router(); }
    function test_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_buybackArrives() public { _flow_buybackArrives(); }
    function test_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function testFuzz_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
    function test_keeperMovesHolders() public { _flow_keeperMovesHolders(); }
    function test_lateBuyCantFlipRace() public { _flow_lateBuyCantFlipRace(); }
    function test_raceEndRecorded() public { _flow_raceEndRecorded(); }
    function test_lastSecondBuyCounts() public { _flow_lastSecondBuyCounts(); }
    function test_winnerTradesAfterRecord() public { _flow_winnerTradesAfterRecord(); }
    function test_pumpBeforeArrivalGainsNothing() public { _flow_pumpBeforeArrivalGainsNothing(); }
    function test_anyoneRecordsAtTheEnd() public { _flow_anyoneRecordsAtTheEnd(); }
    function test_mergeRaisesPrice() public { _flow_mergeRaisesPrice(); }
    function test_mergeSkipsPumpedCoin() public { _flow_mergeSkipsPumpedCoin(); }
}

/// A smart wallet that accepts no signature (ERC-1271 always says no).
contract SigRejecter {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}
