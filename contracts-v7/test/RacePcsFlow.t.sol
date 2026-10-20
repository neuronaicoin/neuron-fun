// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey as PcsKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency as PcsCurrency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta as PcsDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath as PcsTickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {OmniHub} from "../src/omni/OmniHub.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../src/omni/ConsolidatorV6.sol";
import {OmniCoinDeployer} from "../src/omni/OmniDeployers.sol";
import {RaceBuilder} from "../src/race/RaceBuilder.sol";
import {RaceBuilderPcs, IPriceFeedPcs, IWrappedNative, IPancakeV3PoolMin} from "../src/race/RaceBuilderPcs.sol";
import {RaceLaunchHookPcs} from "../src/race/RaceLaunchHookPcs.sol";
import {RaceTradePcs, IRaceBuilderPcsPools} from "../src/race/RaceTradePcs.sol";
import {RaceCross, RaceCrossPcs, IRaceRouter} from "../src/race/RaceCross.sol";
import {CrossSpoke, ICrossMinter} from "./CrossSpoke.sol";

/// A wallet that refuses native coins.
contract NoNativePcs {
    receive() external payable {
        revert("no thanks");
    }
}
import {RaceLaunchHook} from "../src/race/RaceLaunchHook.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USD6, Swapper} from "./RaceFlow.sol";

/// BNB Chain's USDC has 18 decimals.
contract USD18 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function burn(address from, uint256 a) external { _burn(from, a); }
}

contract MockWBNB is ERC20 {
    constructor() ERC20("Wrapped BNB", "WBNB") {}
    receive() external payable { _mint(msg.sender, msg.value); }
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external {
        _burn(msg.sender, a);
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "send");
    }
}

contract MockFeedPcs is IPriceFeedPcs {
    int256 public answer;
    uint256 public updatedAt;
    function set(int256 a, uint256 t) external { answer = a; updatedAt = t; }
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

interface IV3Callback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

/// Stand-in for the PancakeSwap v3 USDC/WBNB pool: constant product, 0.05% fee, exact-in only,
/// pays out first and checks the callback paid (the real v3 order).
contract MockV3Pool is IPancakeV3PoolMin {
    // (`trade` kept for compatibility; tests trade through V3Trader like on the real pool)
    address public immutable token0;
    address public immutable token1;
    constructor(address a, address b) { (token0, token1) = a < b ? (a, b) : (b, a); }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 rin = IERC20(tin).balanceOf(address(this));
        uint256 rout = IERC20(tout).balanceOf(address(this));
        uint256 inF = amountIn * 9995;
        uint256 out = (rout * inF) / (rin * 10_000 + inF);
        IERC20(tout).transfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        require(IERC20(tin).balanceOf(address(this)) >= rin + amountIn, "not paid");
    }

    /// outside trader helper: pull `amountIn` of the input token from the caller
    function trade(bool zeroForOne, uint256 amountIn) external {
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 rin = IERC20(tin).balanceOf(address(this));
        uint256 rout = IERC20(tout).balanceOf(address(this));
        IERC20(tin).transferFrom(msg.sender, address(this), amountIn);
        uint256 inF = amountIn * 9995;
        IERC20(tout).transfer(msg.sender, (rout * inF) / (rin * 10_000 + inF));
    }
}

interface IWBNBTest is IWrappedNative {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// Exact-in swaps in a v3 pool (mock or the real PancakeSwap one) for outside traders.
contract V3Trader {
    address private _pool;
    address private _payer;

    /// `limit` = the v3 price limit (0 = none): a big push can stop a few percent away instead
    /// of crossing every tick of the pool
    function trade(IPancakeV3PoolMin pool, bool zeroForOne, uint256 amountIn, uint160 limit) public returns (uint256 out) {
        _pool = address(pool);
        _payer = msg.sender;
        if (limit == 0) limit = zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341;
        (int256 a0, int256 a1) = pool.swap(msg.sender, zeroForOne, int256(amountIn), limit, "");
        _pool = address(0);
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(msg.sender == _pool, "pool");
        IPancakeV3PoolMin p = IPancakeV3PoolMin(_pool);
        if (a0 > 0) IERC20(p.token0()).transferFrom(_payer, msg.sender, uint256(a0));
        if (a1 > 0) IERC20(p.token1()).transferFrom(_payer, msg.sender, uint256(a1));
    }
}

/// Outside traders on PancakeSwap Infinity (what the Universal Router does for GMGN, bots, wallets).
contract PcsDesk is ILockCallback {
    IVault public immutable vault;
    ICLPoolManager public immutable pm;
    constructor(IVault v, ICLPoolManager p) { vault = v; pm = p; }
    receive() external payable {}

    function swap(PcsKey memory key, bool zeroForOne, uint256 amountIn) external payable returns (uint256 out) {
        out = abi.decode(vault.lock(abi.encode(msg.sender, key, zeroForOne, amountIn)), (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "vault");
        (address who, PcsKey memory key, bool z, uint256 x) = abi.decode(data, (address, PcsKey, bool, uint256));
        PcsDelta d = pm.swap(key, ICLPoolManager.SwapParams({zeroForOne: z, amountSpecified: -int256(x),
            sqrtPriceLimitX96: z ? PcsTickMath.MIN_SQRT_RATIO + 1 : PcsTickMath.MAX_SQRT_RATIO - 1}), "");
        int128 o = z ? d.amount1() : d.amount0();
        _settle(key.currency0, who);
        _settle(key.currency1, who);
        return abi.encode(uint256(uint128(o)));
    }

    function _settle(PcsCurrency c, address who) private {
        int256 d = vault.currencyDelta(address(this), c);
        if (d < 0) {
            uint256 owe = uint256(-d);
            if (c.isNative()) {
                vault.settle{value: owe}();
            } else {
                vault.sync(c);
                IERC20(PcsCurrency.unwrap(c)).transferFrom(who, address(vault), owe);
                vault.settle();
            }
        } else if (d > 0) {
            vault.take(c, who, uint256(d));
        }
    }
}

interface IMintBurn {
    function mint(address to, uint256 a) external;
    function burn(address from, uint256 a) external;
}

interface IReceiveConsolidated {
    function receiveConsolidated(bytes32 coinId, uint256 amount, bool toBuyback) external;
}

/// Dollar bridge stand-in between an 18-decimal USDC chain and a 6-decimal one (amounts rescaled).
contract MockBridgeDec is IUsdcBridge {
    IERC20 public immutable usdc;
    IMintBurn public immutable minter;
    uint8 public immutable dec;
    MockBridgeDec public peer;
    address public receiver;
    constructor(IERC20 usdc_, IMintBurn minter_, uint8 dec_) { usdc = usdc_; minter = minter_; dec = dec_; }
    function link(MockBridgeDec peer_, address receiver_) external { peer = peer_; receiver = receiver_; }
    function quote(uint32, uint256) external pure returns (uint256) { return 0; }
    function send(uint32, bytes32 coin, uint256 amount, bool buyback, address) external payable {
        usdc.transferFrom(msg.sender, address(this), amount);
        minter.burn(address(this), amount);
        peer.arrive(coin, (amount * 10 ** peer.dec()) / 10 ** dec, buyback);
    }
    function arrive(bytes32 coin, uint256 amount, bool buyback) external {
        require(msg.sender == address(peer), "peer");
        minter.mint(receiver, amount);
        IReceiveConsolidated(receiver).receiveConsolidated(coin, amount, buyback);
    }
}

/// Chain A (coordinator) is BNB Chain with the PancakeSwap Infinity builder (coin/BNB pools,
/// 18-decimal USDC); chain B runs the USDC builder on Uniswap v4. One coin races on both.
/// Chain A is either all local (RacePcsFlowTest) or the REAL BNB Chain contracts on a fork
/// (test/fork/RacePcsFork.t.sol): PancakeSwap's vault and pool manager, the v3 USDC/WBNB pool,
/// WBNB, USDC and Chainlink BNB/USD.
abstract contract PcsRaceBase is Test, DeployPermit2 {
    uint32 constant A = 40_001;
    uint32 constant B = 40_002;
    uint256 constant D = 1e6; // report dollars and chain B's USDC
    uint256 constant U = 1e18; // chain A's USDC (18 decimals on BNB Chain)
    uint256 constant START_MC = 3_000 * D; // same number on every chain
    uint256 constant SUPPLY = 1_000_000_000 ether;

    address treasury = address(0x7EA5);
    address keeper = address(0x6EE9);
    address creator = address(0xC4EA);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // chain A (BNB, PancakeSwap Infinity)
    IVault vault;
    ICLPoolManager clpm;
    IERC20 usdcA;
    IMintBurn minterA;
    IWBNBTest wbnb;
    IPancakeV3PoolMin v3;
    IPriceFeedPcs feed;
    V3Trader trader;
    MockLzEndpoint epA;
    OmniHub hubA;
    RaceBuilderPcs pb;
    RaceFactory facA;
    ConsolidatorV6 consA;
    MockBridgeDec brA;
    PcsDesk desk;
    // chain B (USDC, Uniswap v4)
    IAllowanceTransfer permit2;
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

    // ---- what differs between the local run and the BNB Chain fork
    function _setupChainA() internal virtual;
    function _freshFeed() internal virtual;
    function _maxFeedAge() internal pure virtual returns (uint256);
    /// USDC that moves the dollar pool far (>2%) / BNB that does the same the other way
    function _bigUsdc() internal pure virtual returns (uint256);
    function _bigBnb() internal pure virtual returns (uint256);

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

    function setUp() public virtual {
        _setupChainA(); // vault, clpm, usdcA, minterA, wbnb, v3, feed
        permit2 = IAllowanceTransfer(deployPermit2());
        trader = new V3Trader();
        epA = new MockLzEndpoint(A);
        hubA = new OmniHub(address(epA), address(this), A, A);
        brA = new MockBridgeDec(usdcA, minterA, 18);
        pb = new RaceBuilderPcs(vault, clpm, usdcA, wbnb, v3, treasury, feed, _maxFeedAge());
        consA = new ConsolidatorV6(usdcA, IHubLocal(address(hubA)), IUsdcBridge(address(brA)));
        {
            address factoryAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
            OmniCoinDeployer cd = new OmniCoinDeployer(factoryAt);
            facA = new RaceFactory(address(this), ILayerZeroEndpointV2(address(epA)), A, usdcA,
                address(hubA), address(pb), treasury, 1, cd, START_MC, 5 * U, 10);
            require(address(facA) == factoryAt, "factory address");
        }
        pb.bind(address(facA), address(consA), address(brA));
        hubA.setFactory(address(facA));
        hubA.setKeeper(keeper);
        facA.setLaunchesOpen(true);
        desk = new PcsDesk(vault, clpm);

        // ---- chain B: the USDC builder on Uniswap v4
        pmB = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        posmB = IPositionManager(deployCode("out/PositionManager.sol/PositionManager.json",
            abi.encode(pmB, permit2, uint256(300_000), IPositionDescriptor(address(0)), IWETH9(address(0)))));
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
        brA.link(brB, address(pb));
        brB.link(brA, address(ub));

        minterA.mint(creator, 1_000 * U);
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
        usdcA.approve(address(trader), type(uint256).max);
        vm.prank(bob);
        wbnb.approve(address(trader), type(uint256).max);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _eids() internal pure returns (uint32[] memory e) {
        e = new uint32[](2);
        e[0] = A;
        e[1] = B;
    }

    address coinB;

    function _launchBoth(uint256 firstA, uint256 firstB, uint8 mode) internal returns (address coin) {
        RaceFactory.Launch memory la = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids(), mode, firstA, 0);
        RaceFactory.Launch memory lb = RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), _eids(), mode, firstB, 0);
        vm.prank(creator);
        (coin,) = facA.launch(la);
        vm.prank(creator);
        (coinB,) = facB.launch(lb);
    }

    function _buyBnb(address coin, address who, uint256 wei_) internal returns (uint256) {
        PcsKey memory k = pb.poolKeyFor(coin);
        vm.prank(who);
        return desk.swap{value: wei_}(k, true, wei_);
    }

    function _buyUsd(address who, uint256 usd) internal returns (uint256) {
        PoolKey memory k = ub.poolKeyFor(coinB);
        bool z = ub.usdcIsCurrency0(coinB);
        vm.prank(who);
        return swB.swap(k, z, usd);
    }

    /// bob trades in the dollar pool: USDC -> WBNB (BNB gets dear) or WBNB -> USDC (BNB gets cheap)
    function _dollarTrade(bool usdcIn, uint256 amountIn) internal virtual returns (uint256 out) {
        out = _dollarPush(usdcIn, amountIn);
    }

    /// a big push: on the real pool it stops ~5% away from today's price (see `_pushLimit`)
    function _dollarPush(bool usdcIn, uint256 amountIn) internal returns (uint256 out) {
        bool z = usdcIn == (address(usdcA) == v3.token0());
        uint160 limit = _pushLimit(z);
        vm.prank(bob);
        out = trader.trade(v3, z, amountIn, limit);
    }

    /// v3 price limit for a big push (0 = none; the local mock pool has no ticks)
    function _pushLimit(bool) internal view virtual returns (uint160) {
        return 0;
    }

    function _bnbDear() internal returns (uint256 wbnbGot) {
        minterA.mint(bob, _bigUsdc());
        wbnbGot = _dollarPush(true, _bigUsdc());
    }

    function _bnbCheap() internal virtual returns (uint256 usdcGot) {
        vm.deal(bob, bob.balance + _bigBnb());
        vm.prank(bob);
        wbnb.deposit{value: _bigBnb()}();
        usdcGot = _dollarPush(false, _bigBnb());
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

    function _stateA(address coin) internal view returns (RaceBuilderPcs.State st) {
        (,,,, st,,,) = pb.races(coin);
    }

    function _stateB(address coin) internal view returns (RaceBuilder.State st) {
        (,,,,, st,) = ub.races(coin);
    }

    /// BNB in 6-decimal dollars at the Chainlink price
    function _usd(uint256 wei_) internal view returns (uint256) {
        return pb.bnbToUsdc(wei_) / 1e12;
    }

    // ------------------------------------------------------------------ tests

    /// The pool is a real PancakeSwap Infinity CL pool: native BNB / coin, dynamic fee, our hook.
    function test_poolKeyIsPancakeCoinBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        PcsKey memory k = pb.poolKeyFor(coin);
        assertTrue(k.currency0.isNative(), "currency0 is native BNB");
        assertEq(PcsCurrency.unwrap(k.currency1), coin);
        assertEq(address(k.poolManager), address(clpm));
        assertEq(k.fee, 0x800000);
        assertEq(uint256(k.parameters) & 0xffff, 0x41, "beforeInitialize + beforeSwap");
        assertEq((uint256(k.parameters) >> 16) & 0xffffff, 200, "tick spacing 200");
        (uint160 sqrtP,,,) = clpm.getSlot0(k.toId());
        assertGt(sqrtP, 0, "pool open");
    }

    /// Same dollar price on both chains; the creator's $5 first buy on A went USDC -> BNB -> coin.
    function test_launchSamePriceBothPairs() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        (uint256 bnb, uint256 coinsA) = pb.poolAmounts(coin);
        (uint256 usd, uint256 coinsB) = ub.poolAmounts(coinB);
        assertApproxEqRel(_usd(bnb), 4_900_000, 0.015e18);
        assertApproxEqAbs(usd, 4_900_000, 2);
        assertGt(IERC20(coin).balanceOf(creator), 0);
        assertApproxEqRel(coinsA, coinsB, 0.015e18);
        assertEq(address(pb).balance, 0, "builder keeps no BNB");
        assertEq(usdcA.balanceOf(address(pb)), 0, "builder keeps no USDC");
        assertEq(wbnb.balanceOf(address(pb)), 0, "builder keeps no WBNB");
    }

    /// The 10% opening fee applies to outside BNB buys; 70% of it to the treasury in BNB.
    function test_launchFeeInBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        uint256 t0 = treasury.balance;
        _buyBnb(coin, alice, 1 ether);
        pb.collectFees(coin);
        assertApproxEqRel(treasury.balance - t0, (0.1 ether * 70) / 100, 0.02e18);
    }

    /// The fee slides from 10% to 2% over the first two minutes, then stays at 2%.
    function test_feeSlidesToFloor() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        PcsKey memory k = pb.poolKeyFor(coin);
        assertEq(pb.hook().feeNow(k), 100_000);
        // absolute times: block.timestamp can be cached between warps in one test
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 60);
        assertEq(pb.hook().feeNow(k), 60_000);
        vm.warp(t0 + 120);
        assertEq(pb.hook().feeNow(k), 20_000);
        vm.warp(t0 + 720);
        assertEq(pb.hook().feeNow(k), 20_000);
    }

    /// Nobody else can open a pool with sasa's hook.
    function test_onlyBuilderOpensPools() public {
        PcsKey memory k = pb.poolKeyFor(address(0xBEEF));
        vm.prank(alice);
        vm.expectRevert();
        clpm.initialize(k, uint160(1 << 96));
    }

    /// BNB chain wins: the USDC chain's money crosses (6 -> 18 decimals), becomes BNB and deepens the pool.
    function test_bnbChainWins() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 1 ether);
        _buyUsd(bob, 100 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Won));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Lost));
        assertGt(consB.pendingPool(_coinId()), 0);
        consB.forward(_coinId());
        assertEq(pb.extraPositions(coin).length, 1, "BNB pool got deeper");
        assertEq(pb.pendingDollars(coin), 0);
        assertEq(usdcA.balanceOf(address(pb)), 0, "all arriving USDC became BNB");
        assertGt(_buyBnb(coin, bob, 0.01 ether), 0, "trading goes on");
    }

    /// The coin's price on the BNB chain, growing when the coin gets dearer (BNB = currency0).
    function _tickPriceA(address coin) internal view returns (int256) {
        (, int24 tick,,) = clpm.getSlot0(pb.poolIdFor(coin));
        return -int256(tick);
    }

    /// v8: the money from the losing chain lifts the BNB chain's price and lands as liquidity.
    function test_mergeRaisesPriceBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 1 ether);
        _buyUsd(bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Won));
        uint256 supply0 = IERC20(coin).totalSupply();
        int256 p0 = _tickPriceA(coin);
        consB.forward(_coinId());
        assertGt(_tickPriceA(coin), p0, "the merge buy lifted the price");
        RaceBuilderPcs.Range[] memory ex = pb.extraPositions(coin);
        assertEq(ex.length, 1);
        assertEq(ex[0].lower, PcsTickMath.minUsableTick(200), "full range");
        assertLe(IERC20(coin).totalSupply(), supply0, "nothing minted");
        assertEq(usdcA.balanceOf(address(pb)), 0, "all arriving USDC used");
        assertGt(_buyBnb(coin, bob, 0.01 ether), 0);
    }

    /// v8: a pumped coin (>20% above its race-end price) gets no merge buy.
    function test_mergeSkipsPumpedCoinBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 1 ether);
        _buyUsd(bob, 200 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        _buyBnb(coin, bob, 5 ether);
        int256 p0 = _tickPriceA(coin);
        consB.forward(_coinId());
        assertEq(_tickPriceA(coin), p0, "no merge buy on a pumped coin");
        assertEq(pb.extraPositions(coin).length, 0, "no position on a pumped coin");
        assertGt(pb.buybackFunds(coin), 0, "the money funds buybacks instead");
    }

    /// USDC chain wins: the BNB pool is emptied once, its BNB swapped to USDC at a fair price.
    /// Once the race is over, a big BNB buy on the losing BNB chain can't make it win: the BNB
    /// in the pool when the five minutes ended is what counts (written down before that buy).
    function test_lateBuyCantFlipRace() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 0.1 ether);
        _buyUsd(bob, 500 * D);
        vm.warp(block.timestamp + 301); // B leads
        (uint256 bnbAtEnd, uint256 coinsAtEnd) = pb.poolAmounts(coin);
        _buyBnb(coin, bob, 50 ether); // after the end
        (uint256 liveBnb,) = pb.poolAmounts(coin);
        assertGt(_usd(liveBnb), 500 * D, "the live pool would say A");
        (uint256 m, uint256 c, bool rec,) = pb.raceEnd(coin);
        assertTrue(rec);
        assertEq(m, bnbAtEnd, "the BNB before the late buy");
        assertEq(c, coinsAtEnd);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Lost));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        // asking again (anyone may) changes nothing
        PcsKey memory key = pb.poolKeyFor(coin);
        vm.prank(alice);
        assertTrue(pb.recordRaceEnd(key));
    }

    function test_usdcChainWins() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 0.1 ether);
        _buyUsd(bob, 500 * D);
        vm.warp(block.timestamp + 301);
        (uint256 bnbInPool,) = pb.poolAmounts(coin);
        uint256 t0 = usdcA.balanceOf(treasury);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Lost));
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        (uint256 e1, uint256 c1) = pb.poolAmounts(coin);
        assertEq(e1 + c1, 0, "BNB pool emptied");
        assertEq(pb.lostPending(coin), 0, "handed over at once");
        uint256 pending = consA.pendingPool(_coinId());
        assertGe(pending, (_usd(bnbInPool) * 1e12 * 98 * 98) / (100 * 100));
        assertGt(usdcA.balanceOf(treasury) - t0, 0, "graduation fee");
        assertEq(address(pb).balance, 0, "no BNB left behind");
        PcsKey memory k = pb.poolKeyFor(coin);
        vm.prank(alice);
        vm.expectRevert();
        desk.swap{value: 0.01 ether}(k, true, 0.01 ether);
        consA.forward(_coinId());
        assertEq(ub.extraPositions(coinB).length, 1, "money reached B");
    }

    function test_staleFeedStopsReport() public {
        _launchBoth(5 * U, 5 * D, 0);
        vm.warp(block.timestamp + 301 + _maxFeedAge() + 1 hours);
        bytes32 id = _coinId();
        vm.prank(keeper);
        vm.expectRevert(RaceBuilderPcs.BadPrice.selector);
        hubA.freeze(id, "");
    }

    /// Arriving USDC waits when USDC -> BNB would be unfair, then anyone finishes it.
    function test_arrivalWaitsWhenUnfair() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 1 ether);
        vm.warp(block.timestamp + 301);
        _endRace();
        uint256 wbnbGot = _bnbDear();
        consB.forward(_coinId());
        assertGt(pb.pendingDollars(coin), 0, "USDC waits instead of a bad swap");
        assertEq(pb.extraPositions(coin).length, 0);
        _dollarTrade(false, wbnbGot); // the market comes back
        pb.convertPending(coin);
        assertEq(pb.pendingDollars(coin), 0);
        assertEq(pb.extraPositions(coin).length, 1);
    }

    /// A losing hand-over at an unfair BNB price waits (the verdict still goes through);
    /// once the market is back, anyone finishes it, in parts if they like.
    function test_unfairHandOverWaits() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 0.1 ether);
        _buyUsd(bob, 500 * D);
        vm.warp(block.timestamp + 301);
        uint256 usdcGot = _bnbCheap();
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Lost), "verdict went through");
        assertEq(uint8(_stateB(coinB)), uint8(RaceBuilder.State.Won));
        uint256 waiting = pb.lostPending(coin);
        assertGt(waiting, 0, "BNB waits instead of a bad swap");
        assertEq(consA.pendingPool(_coinId()), 0);
        assertEq(address(pb).balance, pb.bnbReserved());
        vm.expectRevert();
        pb.convertLost(coin, 0);
        _dollarTrade(true, usdcGot); // the market comes back
        pb.convertLost(coin, waiting / 2);
        pb.convertLost(coin, 0);
        assertEq(pb.lostPending(coin), 0);
        assertEq(address(pb).balance, 0, "no BNB left behind");
        assertGe(consA.pendingPool(_coinId()), (_usd(waiting) * 1e12 * 97) / 100);
        consA.forward(_coinId());
        assertEq(ub.extraPositions(coinB).length, 1, "money reached B");
    }

    function test_accessRules() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        vm.prank(alice);
        (bool ok,) = address(pb).call{value: 1 ether}("");
        assertFalse(ok, "no BNB from outside");
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotSelf.selector);
        pb.placeArrived(coin, 1, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotSelf.selector);
        pb.handOver(coin, 1);
        bytes32 id = _coinId();
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotBridge.selector);
        pb.receiveConsolidated(id, 1, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotSeat.selector);
        pb.settle(coin, B, false);
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.OnlyVault.selector);
        pb.lockAcquired("");
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotOurCall.selector);
        pb.pancakeV3SwapCallback(1, 0, "");
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotOpen.selector);
        pb.convertLost(coin, 0);
    }

    /// The losing chain's dollars arrive on the BNB chain as BNB buy orders. Pushing the price up
    /// just before and selling into them afterwards must not pay.
    function test_pumpBeforeArrivalGainsNothing() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, 8 ether);
        _buyUsd(bob, 2_000 * D);
        vm.warp(block.timestamp + 301);
        _endRace();
        assertEq(uint8(_stateA(coin)), uint8(RaceBuilderPcs.State.Won));
        uint256 b0 = bob.balance;
        _buyBnb(coin, bob, 20 ether);
        consB.forward(_coinId());
        assertEq(pb.extraPositions(coin).length, 0, "pumped: nothing placed in the pool");
        assertGt(pb.buybackFunds(coin), 0, "the money funds buybacks instead");
        PcsKey memory k = pb.poolKeyFor(coin);
        vm.startPrank(bob);
        IERC20(coin).approve(address(desk), type(uint256).max);
        desk.swap(k, false, IERC20(coin).balanceOf(bob));
        vm.stopPrank();
        assertLt(bob.balance, b0, "no profit from pushing the price");
    }

    function test_buybackModeBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 1);
        _buyBnb(coin, alice, 1 ether);
        pb.collectFees(coin);
        assertGt(pb.buybackFunds(coin), 0);
        uint256 s0 = IERC20(coin).totalSupply();
        vm.prank(alice);
        vm.expectRevert(RaceBuilderPcs.NotKeeper.selector);
        pb.buyback(coin, 1);
        vm.prank(keeper);
        (uint256 spent, uint256 burned) = pb.buyback(coin, 1);
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(IERC20(coin).totalSupply(), s0 - burned);
    }

    /// Sellers get BNB back from the pool (outside apps can trade both ways).
    function test_sellForBnb() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        uint256 got = _buyBnb(coin, alice, 1 ether);
        vm.warp(block.timestamp + 301);
        PcsKey memory k = pb.poolKeyFor(coin);
        vm.startPrank(alice);
        IERC20(coin).approve(address(desk), type(uint256).max);
        uint256 b0 = alice.balance;
        desk.swap(k, false, got);
        vm.stopPrank();
        assertGt(alice.balance - b0, 0.5 ether, "sold back for BNB");
    }

    /// Users trade with USDC only: USDC -> BNB -> coin and back in one call each.
    function test_tradeWithUsdc() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        vm.warp(block.timestamp + 301); // opening fee over: 2%
        RaceTradePcs t = new RaceTradePcs(IRaceBuilderPcsPools(address(pb)));
        minterA.mint(alice, 100 * U);
        vm.startPrank(alice);
        usdcA.approve(address(t), type(uint256).max);
        IERC20(coin).approve(address(t), type(uint256).max);
        uint256 u0 = usdcA.balanceOf(alice);
        uint256 got = t.buy(coin, 100 * U, 1, alice, block.timestamp);
        assertGt(got, 0);
        assertEq(usdcA.balanceOf(alice), u0 - 100 * U);
        uint256 back = t.sell(coin, got, 1, alice, block.timestamp);
        vm.stopPrank();
        // a round trip costs only the fees (2% + 2% in the coin pool, the dollar pool's fee)
        assertGt(back, 94 * U, "round trip");
        assertLt(back, 100 * U);
        assertEq(IERC20(coin).balanceOf(alice), 0);
        assertEq(address(t).balance, 0, "router keeps no BNB");
        assertEq(usdcA.balanceOf(address(t)), 0, "router keeps no USDC");
        assertEq(wbnb.balanceOf(address(t)), 0, "router keeps no WBNB");
        assertEq(IERC20(coin).balanceOf(address(t)), 0, "router keeps no coins");
        // the user's minimum protects the trade; an old deadline is refused
        minterA.mint(alice, 10 * U);
        vm.startPrank(alice);
        vm.expectRevert();
        t.buy(coin, 10 * U, type(uint256).max, alice, block.timestamp);
        vm.expectRevert(RaceTradePcs.Expired.selector);
        t.buy(coin, 10 * U, 1, alice, block.timestamp - 1);
        vm.stopPrank();
        // nobody can call the inside steps
        vm.expectRevert(RaceTradePcs.NotOurCall.selector);
        t.lockAcquired("");
        vm.expectRevert(RaceTradePcs.NotOurCall.selector);
        t.pancakeV3SwapCallback(1, 0, "");
    }

    /// A sasa account (dollars on Base) launches here through Across with its signature: the
    /// coin, fees and first-buy coins are the user's, a little of the money becomes gas, the
    /// change goes back to the user, nothing stays in RaceCross.
    function test_crossLaunch() public {
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossPcs x = new RaceCrossPcs(spoke, usdcA, IWrappedNative(address(wbnb)), pb.dollarPool(), IRaceRouter(address(new RaceTradePcs(IRaceBuilderPcsPools(address(pb))))), facA, 8453,
            IERC20(address(0xBA5E)), 6, 0.0002 ether);
        facA.setLauncher(address(x));
        uint256 pk = 0xA11CE5EC2E7;
        address u = vm.addr(pk);
        RaceFactory.Launch memory l = RaceFactory.Launch("Moon Dog", "MDOG", "", "", bytes32("k9"), _eids(), 0, 5 * U, 0);
        uint256 dl = vm.getBlockTimestamp() + 10 minutes;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, x.launchDigest(u, l, 30 * U / 100, dl));
        bytes memory m = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(u, l, 30 * U / 100, dl, abi.encodePacked(r, sg, v))));
        uint256 g0 = gasleft();
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 6 * U, m);
        emit log_named_uint("cross launch fill gas", g0 - gasleft());
        assertLt(g0 - gasleft(), 7_000_000, "a launch fill fits easily in a block");
        address coin = facA.coinAddress(u, bytes32("k9"));
        assertGt(coin.code.length, 0, "launched");
        assertGt(IERC20(coin).balanceOf(u), 0, "first-buy coins are the creator's");
        assertGt(u.balance, 0, "gas topped up");
        assertEq(usdcA.balanceOf(u), 6 * U - 5 * U - facA.raceFee() - 30 * U / 100, "change back");
        assertEq(usdcA.balanceOf(address(x)), 0, "nothing kept");
        assertEq(address(x).balance, 0);
        // the same order again can't launch twice: refused (Across returns the dollars on Base)
        vm.expectRevert(RaceCross.AlreadyLaunched.selector);
        spoke.fill{gas: 1_000_000}(address(usdcA), ICrossMinter(address(minterA)), address(x), 6 * U, m);
    }

    /// Dollars kept on Base buy here through Across: a user with no BNB gets a little gas and the
    /// coins; selling sends the dollars home to Base (6 decimals there); a failed buy refunds.
    function test_crossBuyAndSellHome() public {
        address coin = _launchBoth(5 * U, 5 * D, 0);
        vm.warp(block.timestamp + 301);
        RaceTradePcs t = new RaceTradePcs(IRaceBuilderPcsPools(address(pb)));
        CrossSpoke spoke = new CrossSpoke();
        RaceCrossPcs x = new RaceCrossPcs(spoke, usdcA, IWrappedNative(address(wbnb)), pb.dollarPool(), IRaceRouter(address(t)), facA, 8453,
            IERC20(address(0xBA5E)), 6, 0.0002 ether); // top-up below ~12 cents of BNB
        address u = address(0xC0FFEE01);

        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 20 * U,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(u, coin, 1, 30 * U / 100, block.timestamp + 1 hours))));
        uint256 coins = IERC20(coin).balanceOf(u);
        assertGt(coins, 0, "coins delivered");
        assertGt(u.balance, 0, "gas delivered");
        {
            (, int256 px,,,) = feed.latestRoundData(); // 8 decimals
            uint256 cents = (u.balance * uint256(px) * 100) / 1e26;
            assertGe(cents, 28, "about 30 cents of BNB (pool fee and price gap aside)");
            assertLe(cents, 31, "not more than asked");
        }
        assertEq(usdcA.balanceOf(address(x)), 0, "nothing kept");
        assertEq(address(x).balance, 0, "no BNB kept");
        assertEq(wbnb.balanceOf(address(x)), 0, "no WBNB kept");

        vm.startPrank(u);
        IERC20(coin).approve(address(x), coins);
        uint256 got = x.sellAndSendHome(coin, coins, 1, U / 100, block.timestamp);
        vm.stopPrank();
        assertGt(got, 18 * U, "sold for most of the $19.70 put in");
        assertEq(spoke.lastDepositor(), u);
        assertEq(spoke.lastDst(), 8453);
        assertEq(spoke.lastOutput(), (got - U / 100) / 1e12, "asked on Base in 6 decimals");
        assertEq(IERC20(coin).balanceOf(address(x)), 0);
        assertEq(usdcA.balanceOf(address(x)), 0);

        // a wallet that refuses BNB loses only its top-up: the whole amount buys coins
        {
            address w = address(new NoNativePcs());
            spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 10 * U,
                abi.encode(uint8(0), abi.encode(RaceCross.Order(w, coin, 1, 30 * U / 100, block.timestamp + 1 hours))));
            assertEq(w.balance, 0);
            assertGt(IERC20(coin).balanceOf(w), 0, "bought anyway");
            assertEq(usdcA.balanceOf(address(x)), 0);
            assertEq(address(x).balance, 0);
        }
        address v = address(0xC0FFEE02);
        spoke.fill(address(usdcA), ICrossMinter(address(minterA)), address(x), 10 * U,
            abi.encode(uint8(0), abi.encode(RaceCross.Order(v, coin, type(uint256).max, 0, block.timestamp + 1 hours))));
        assertEq(usdcA.balanceOf(v), 10 * U, "refunded in full");
        vm.expectRevert(RaceCrossPcs.NotOurCall.selector);
        x.pancakeV3SwapCallback(1, 0, "");
    }

    function testFuzz_supplyNeverGrows(uint96 bnbIn, uint96 usdIn) public {
        uint256 e = bound(uint256(bnbIn), 0.005 ether, 80 ether);
        uint256 u = bound(uint256(usdIn), 1 * D, 50_000 * D);
        address coin = _launchBoth(5 * U, 5 * D, 0);
        _buyBnb(coin, alice, e);
        _buyUsd(bob, u);
        vm.warp(block.timestamp + 301);
        _endRace();
        bool aWon = _stateA(coin) == RaceBuilderPcs.State.Won;
        assertEq(aWon, _stateB(coinB) == RaceBuilder.State.Lost);
        if (aWon) consB.forward(_coinId());
        else if (consA.pendingPool(_coinId()) > 0) consA.forward(_coinId());
        assertLe(IERC20(coin).totalSupply() + IERC20(coinB).totalSupply(), SUPPLY);
        assertEq(address(pb).balance, pb.bnbReserved(), "builder holds only reserved BNB");
        assertEq(usdcA.balanceOf(address(pb)), pb.dollarsReserved(), "builder holds only reserved USDC");
    }
}

/// Chain A all local: PancakeSwap Infinity deployed here, a mock v3 dollar pool and feed.
contract RacePcsFlowTest is PcsRaceBase {
    MockFeedPcs mfeed;

    function _setupChainA() internal override {
        vm.warp(1_800_000_000);
        Vault v = new Vault();
        CLPoolManager p = new CLPoolManager(IVault(address(v)));
        v.registerApp(address(p));
        vault = IVault(address(v));
        clpm = ICLPoolManager(address(p));
        USD18 u = new USD18();
        usdcA = IERC20(address(u));
        minterA = IMintBurn(address(u));
        MockWBNB w = new MockWBNB();
        wbnb = IWBNBTest(address(w));
        MockV3Pool pool = new MockV3Pool(address(u), address(w));
        v3 = pool;
        // the dollar pool: $600 per BNB, 1,000 BNB + $600k
        vm.deal(address(this), 10_000 ether);
        w.deposit{value: 1_000 ether}();
        w.transfer(address(pool), 1_000 ether);
        u.mint(address(pool), 600_000 * U);
        mfeed = new MockFeedPcs();
        mfeed.set(600e8, block.timestamp);
        feed = mfeed;
    }

    function _freshFeed() internal override { mfeed.set(600e8, block.timestamp); }
    function _maxFeedAge() internal pure override returns (uint256) { return 1 hours; }
    function _bigUsdc() internal pure override returns (uint256) { return 400_000 * U; }
    function _bigBnb() internal pure override returns (uint256) { return 900 ether; }
}
