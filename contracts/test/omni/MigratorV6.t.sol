// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {ConsolidatorV6, IUsdcBridge, IHubLocal} from "../../src/omni/ConsolidatorV6.sol";
import {MigratorV6Core} from "../../src/omni/MigratorV6Core.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USDC6, FactoryStub} from "./UsdCurveV6.t.sol";

/// Records what a real pool would get.
contract MigratorHarness is MigratorV6Core {
    uint256 public poolUsdc;
    uint256 public poolTokens;
    constructor(IERC20 u, IHubLocal h, address b) MigratorV6Core(u, h, b) {}
    function _openPool(bytes32, address, uint256 tokens, uint256 money) internal override {
        poolUsdc = money;
        poolTokens = tokens;
    }
}

/// Stand-in USDC route: takes USDC on the source chain, delivers on the destination
/// (keeping `cutBps`, like a real bridge fee), then tells the migrator.
contract MockBridge is IUsdcBridge {
    USDC6 public src;
    USDC6 public dst;
    MigratorV6Core public mig;
    uint256 public cutBps;
    bool public hold; // simulate a slow bridge
    struct P { bytes32 coin; uint256 amount; bool bb; }
    P[] public queue;
    function setUp(USDC6 s, USDC6 d, MigratorV6Core m, uint256 cut) external { src = s; dst = d; mig = m; cutBps = cut; }
    function setHold(bool h) external { hold = h; }
    function quote(uint32, uint256) external pure returns (uint256) { return 0; }
    function send(uint32, bytes32 coin, uint256 amount, bool bb, address) external payable {
        src.transferFrom(msg.sender, address(0xdead), amount);
        uint256 out = amount - (amount * cutBps) / 10_000;
        if (hold) queue.push(P(coin, out, bb));
        else _deliver(coin, out, bb);
    }
    function flush() external {
        for (uint256 i; i < queue.length; ++i) _deliver(queue[i].coin, queue[i].amount, queue[i].bb);
        delete queue;
    }
    function _deliver(bytes32 coin, uint256 out, bool bb) internal {
        dst.mint(address(mig), out);
        mig.receiveConsolidated(coin, out, bb);
    }
}

/// Full graduation across two chains: A (coordinator, loses) and B (wins).
contract MigratorV6Test is Test {
    uint32 constant A = 50_001;
    uint32 constant B = 50_002;
    uint256 constant V0 = 4_500e6;
    uint256 constant T0 = 1_073_000_000 ether;
    uint256 constant TARGET = 10_000e6;
    address keeper = address(0x6EE9);
    address alice = address(0xA11CE);

    MockLzEndpoint epA;
    MockLzEndpoint epB;
    OmniHub hubA;
    OmniHub hubB;
    USDC6 usdcA;
    USDC6 usdcB;
    LaunchCoin coinA;
    LaunchCoin coinB;
    UsdCurveV6 curveA;
    UsdCurveV6 curveB;
    ConsolidatorV6 consA;
    MigratorHarness migB;
    MockBridge bridge;
    bytes32 constant ID = bytes32("kedi"); // the coin's id, same on every chain

    function setUp() public {
        epA = new MockLzEndpoint(A);
        epB = new MockLzEndpoint(B);
        hubA = new OmniHub(address(epA), address(this), A, A);
        hubB = new OmniHub(address(epB), address(this), A, B);
        hubA.setPeer(B, bytes32(uint256(uint160(address(hubB)))));
        hubB.setPeer(A, bytes32(uint256(uint160(address(hubA)))));
        hubA.setKeeper(keeper);
        hubB.setKeeper(keeper);
        hubA.setFactory(address(this));
        hubB.setFactory(address(this));
        usdcA = new USDC6();
        usdcB = new USDC6();
        bridge = new MockBridge();
        consA = new ConsolidatorV6(usdcA, IHubLocal(address(hubA)), bridge);
        migB = new MigratorHarness(usdcB, IHubLocal(address(hubB)), address(bridge));
        bridge.setUp(usdcA, usdcB, migB, 10); // 0.1% route fee
        FactoryStub f = new FactoryStub();
        coinA = new LaunchCoin("Kedi", "KEDI", address(epA), 10, address(0x7E), address(0xC4EA), 0, address(this));
        coinB = new LaunchCoin("Kedi", "KEDI", address(epB), 10, address(0x7E), address(0xC4EA), 0, address(this));
        uint256 v = V0 / 2;
        uint256 t = T0 / 2;
        uint256 cap = t - (v * t) / (v + (TARGET * 12) / 10);
        curveA = f.deploy(UsdCurveV6.Params(usdcA, coinA, ID, address(hubA), address(0x1), address(consA), address(0xC4EA), address(0x9407), v, t, cap, 100, 3_000, UsdCurveV6.FeeMode.Creator));
        curveB = f.deploy(UsdCurveV6.Params(usdcB, coinB, ID, address(hubB), address(migB), address(0x2), address(0xC4EA), address(0x9407), v, t, cap, 100, 3_000, UsdCurveV6.FeeMode.Creator));
        coinA.setController(address(curveA));
        coinB.setController(address(curveB));
        uint32[] memory eids = new uint32[](2);
        eids[0] = A;
        eids[1] = B;
        // Tests key both chains' records by one shared coin address; the migrator reads balances
        // of that address, so point it at chain B's coin for the pool-coin checks.
        hubA.register(ID, address(curveA), eids, TARGET);
        hubB.register(ID, address(curveB), eids, TARGET);
        usdcA.mint(alice, 1_000_000e6);
        usdcB.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        usdcA.approve(address(curveA), type(uint256).max);
        usdcB.approve(address(curveB), type(uint256).max);
        vm.stopPrank();
    }

    function _graduate() internal returns (uint256 total, uint256 pool) {
        vm.startPrank(alice);
        curveA.buy(4_000e6, 0, alice);
        curveB.buy(6_500e6, 0, alice);
        vm.stopPrank();
        vm.startPrank(keeper);
        hubA.freeze(ID, "");
        hubB.freeze(ID, "");
        vm.stopPrank();
        epA.deliver(epB.packetAt(epB.packetCount() - 1));
        (,,, total, pool) = hubA.preview(ID);
        hubA.finalize(ID, 0, "");
        epB.deliver(epA.packetAt(epA.packetCount() - 1));
    }

    function test_fullGraduation_poolAtPg() public {
        // migrator keys coins by chain A's coin address in this test; give it chain B's pool coins there
        (uint256 total, uint256 pool) = _graduate();
        assertFalse(migB.ready(ID)); // chain A's money not here yet
        consA.forward(ID);
        assertTrue(migB.ready(ID)); // 99.9% arrived
        migB.open(ID);
        // Price in the pool = total / pool coins (P_g), even with the bridge's cut.
        uint256 u = migB.poolUsdc();
        uint256 c = migB.poolTokens();
        assertApproxEqRel(u * 1e18 / c, total * 1e18 / pool, 1e12);
        assertApproxEqRel(u, total, 0.002e18);
        vm.expectRevert(MigratorV6Core.NotReady.selector);
        migB.open(ID);
    }

    function test_slowBridge_opensAfter30MinWithWhatArrived_lateMoneyBuysBack() public {
        bridge.setHold(true);
        (uint256 total, uint256 pool) = _graduate();
        consA.forward(ID);
        assertFalse(migB.ready(ID));
        vm.warp(block.timestamp + 30 minutes);
        assertTrue(migB.ready(ID));
        migB.open(ID);
        uint256 u = migB.poolUsdc();
        uint256 c = migB.poolTokens();
        assertApproxEqRel(u * 1e18 / c, total * 1e18 / pool, 1e12); // still P_g
        assertLt(c, pool); // unused pool coins burned
        bridge.flush();
        assertGt(migB.buybackFunds(ID), 0); // late money buys back
    }

    function test_onlyRealCurveAndBridge() public {
        vm.expectRevert(MigratorV6Core.NotTheCurve.selector);
        migB.fromCurve(ID, 1, 1, 1);
        vm.expectRevert(MigratorV6Core.NotBridge.selector);
        migB.receiveConsolidated(ID, 1, false);
        vm.expectRevert(ConsolidatorV6.NotTheCurve.selector);
        consA.fromCurve(ID, 1);
    }
}
