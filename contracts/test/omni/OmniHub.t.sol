// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USDC6, FactoryStub, SinkStub} from "./UsdCurveV6.t.sol";

/// Two chains: A hosts the coordinator, B is a second chain. One coin on both.
contract OmniHubTest is Test {
    uint32 constant A = 40_001;
    uint32 constant B = 40_002;
    uint256 constant V0 = 4_500e6;
    uint256 constant T0 = 1_073_000_000 ether;
    uint256 constant TARGET = 10_000e6;

    struct Net {
        MockLzEndpoint ep;
        OmniHub hub;
        LaunchCoin coin;
        UsdCurveV6 curve;
        USDC6 usdc;
        FactoryStub factory;
    }

    Net a;
    Net b;
    address keeper = address(0x6EE9);
    address alice = address(0xA11CE);
    address migA;
    address migB;
    address consA;
    address consB;

    function _chain(uint32 eid, address mig, address cons) internal returns (Net memory c) {
        c.ep = new MockLzEndpoint(eid);
        c.hub = new OmniHub(address(c.ep), address(this), A, eid);
        c.usdc = new USDC6();
        c.factory = new FactoryStub();
        c.coin = new LaunchCoin("Kedi", "KEDI", address(c.ep), 10, address(0x7E), address(0xC4EA), 0, address(this));
        uint256 v = V0 / 2;
        uint256 t = T0 / 2;
        uint256 r = (TARGET * 12) / 10;
        c.curve = c.factory.deploy(
            UsdCurveV6.Params(
                c.usdc, c.coin, bytes32("kedi"), address(c.factory), address(c.hub), mig, cons, address(0xC4EA), address(0x9407), v, t, t - (v * t) / (v + r), 100, 3_000,
                UsdCurveV6.FeeMode.Creator
            )
        );
        c.coin.setController(address(c.curve));
        c.hub.setFactory(address(this));
        c.hub.setKeeper(keeper);
        uint32[] memory eids = new uint32[](2);
        eids[0] = A;
        eids[1] = B;
        // In tests both coins share an address key: register under chain A's coin address on both.
        c.usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        c.usdc.approve(address(c.curve), type(uint256).max);
    }

    bytes32 coinKey;

    function setUp() public {
        migA = address(new SinkStub());
        migB = address(new SinkStub());
        consA = address(new SinkStub());
        consB = address(new SinkStub());
        a = _chain(A, migA, consA);
        b = _chain(B, migB, consB);
        a.hub.setPeer(B, bytes32(uint256(uint160(address(b.hub)))));
        b.hub.setPeer(A, bytes32(uint256(uint160(address(a.hub)))));
        coinKey = bytes32("kedi"); // the coin's shared address on every chain (CREATE3)
        uint32[] memory eids = new uint32[](2);
        eids[0] = A;
        eids[1] = B;
        a.hub.register(coinKey, address(a.curve), eids, TARGET);
        b.hub.register(coinKey, address(b.curve), eids, TARGET);
    }

    function _deliverBtoA() internal {
        a.ep.deliver(b.ep.packetAt(b.ep.packetCount() - 1));
    }

    function _deliverAtoB() internal {
        b.ep.deliver(a.ep.packetAt(a.ep.packetCount() - 1));
    }

    function _freezeBoth() internal {
        vm.startPrank(keeper);
        a.hub.freeze(coinKey, "");
        b.hub.freeze(coinKey, "");
        vm.stopPrank();
        _deliverBtoA();
    }

    function test_graduation_richestChainWins_poolMath() public {
        vm.startPrank(alice);
        a.curve.buy(4_000e6, 0, alice);
        b.curve.buy(6_500e6, 0, alice);
        vm.stopPrank();
        _freezeBoth();
        (bool ready, bool grad, uint32 winner, uint256 total, uint256 pool) = a.hub.preview(coinKey);
        assertTrue(ready && grad);
        assertEq(winner, B);
        assertEq(total, a.curve.realNative() + b.curve.realNative());
        // poolTokens = R * V0 * T0 / (V0 + R)^2
        uint256 expect = (total * T0 / (V0 + total)) * V0 / (V0 + total);
        assertEq(pool, expect);
        assertLe(a.curve.sold() + b.curve.sold() + pool, 1_000_000_000 ether);

        uint256 moneyB = b.curve.realNative();
        uint256 moneyA = a.curve.realNative();
        a.hub.finalize(coinKey, 0, "");
        _deliverAtoB();
        assertEq(b.usdc.balanceOf(migB), moneyB);
        assertEq(b.coin.balanceOf(migB), pool);
        assertEq(a.usdc.balanceOf(consA), moneyA);
        assertTrue(a.coin.bridgeOpen() && b.coin.bridgeOpen());
        assertEq(a.coin.homeEid(), B);
        vm.expectRevert(OmniHub.NotReady.selector);
        a.hub.finalize(coinKey, 0, "");
    }

    function test_shortOfTarget_reopensEverywhere() public {
        vm.prank(alice);
        a.curve.buy(1_000e6, 0, alice);
        _freezeBoth();
        (, bool grad,,,) = a.hub.preview(coinKey);
        assertFalse(grad);
        a.hub.finalize(coinKey, 0, "");
        _deliverAtoB();
        vm.startPrank(alice);
        a.curve.buy(1e6, 0, alice);
        b.curve.buy(1e6, 0, alice);
        vm.stopPrank();
        // Next round works the same way.
        vm.prank(alice);
        b.curve.buy(9_500e6, 0, alice);
        _freezeBoth();
        (bool ready, bool grad2, uint32 w,,) = a.hub.preview(coinKey);
        assertTrue(ready && grad2);
        assertEq(w, B);
    }

    function test_notReadyUntilAllReport() public {
        vm.prank(keeper);
        a.hub.freeze(coinKey, "");
        vm.expectRevert(OmniHub.NotReady.selector);
        a.hub.finalize(coinKey, 0, "");
    }

    function test_publicFreezeOnlyWhenKeeperQuiet() public {
        vm.prank(alice);
        vm.expectRevert(OmniHub.NotAllowed.selector);
        a.hub.freeze(coinKey, "");
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(alice);
        a.hub.freeze(coinKey, "");
        // ... and not again for an hour (after a reopen)
        vm.prank(keeper);
        b.hub.freeze(coinKey, "");
        _deliverBtoA();
        a.hub.finalize(coinKey, 0, "");
        _deliverAtoB();
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(alice);
        vm.expectRevert(OmniHub.NotAllowed.selector);
        a.hub.freeze(coinKey, "");
    }

    function test_decisionsOnlyFromCoordinator() public {
        // A forged verdict claiming to come from chain B is refused on chain A... and B can't send one.
        bytes memory forged = abi.encode(uint8(2), coinKey, uint64(0), B, uint256(1));
        MockLzEndpoint.Packet memory p =
            MockLzEndpoint.Packet(B, address(b.hub), A, bytes32(uint256(uint160(address(a.hub)))), forged);
        vm.expectRevert(OmniHub.NotAllowed.selector);
        a.ep.deliver(p);
    }

    function test_reportMustComeFromItsOwnChain() public {
        // Chain B's hub reporting for chain A is ignored.
        bytes memory fake = abi.encode(uint8(1), coinKey, uint64(0), A, uint256(1e12), uint256(0), _eids(), V0 / 2, T0 / 2, TARGET);
        MockLzEndpoint.Packet memory p =
            MockLzEndpoint.Packet(B, address(b.hub), A, bytes32(uint256(uint160(address(a.hub)))), fake);
        a.ep.deliver(p);
        (, uint8 count,,) = a.hub.tallyOf(coinKey);
        assertEq(count, 0);
    }

    function _eids() internal pure returns (uint32[] memory e) {
        e = new uint32[](2);
        e[0] = A;
        e[1] = B;
    }

    // ---------------------------------------------------------------- one chain only

    function _solo(bytes32 key) internal returns (UsdCurveV6 curve, LaunchCoin coin) {
        coin = new LaunchCoin("Solo", "SOLO", address(b.ep), 10, address(0x7E), address(0xC4EA), 0, address(this));
        uint256 r = (TARGET * 12) / 10;
        curve = b.factory.deploy(
            UsdCurveV6.Params(
                b.usdc, coin, key, address(b.factory), address(b.hub), migB, consB, address(0xC4EA), address(0x9407), V0, T0, T0 - (V0 * T0) / (V0 + r), 100, 3_000,
                UsdCurveV6.FeeMode.Creator
            )
        );
        coin.setController(address(curve));
        uint32[] memory eids = new uint32[](1);
        eids[0] = B; // not the coordinator's chain
        b.hub.register(key, address(curve), eids, TARGET);
        vm.prank(alice);
        b.usdc.approve(address(curve), type(uint256).max);
    }

    function test_singleChain_graduatesInTheFreezeItself_noMessages() public {
        bytes32 key = bytes32("solo");
        (UsdCurveV6 curve, LaunchCoin coin) = _solo(key);
        vm.prank(alice);
        curve.buy(10_500e6, 0, alice);
        uint256 money = curve.realNative();
        uint256 sold = curve.sold();
        uint256 packets = b.ep.packetCount();
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        b.hub.freeze{value: 0.01 ether}(key, "");
        assertEq(b.ep.packetCount(), packets, "nothing sent over LayerZero");
        assertEq(keeper.balance, 1 ether, "fee handed back");
        uint256 expect = (money * T0 / (V0 + money)) * V0 / (V0 + money);
        if (sold + expect > 1_000_000_000 ether) expect = 1_000_000_000 ether - sold;
        assertEq(b.usdc.balanceOf(migB), money, "money in the migrator at once");
        assertEq(coin.balanceOf(migB), expect, "pool tokens at once");
        assertTrue(coin.bridgeOpen());
        assertEq(coin.homeEid(), B);
    }

    function test_singleChain_shortOfTarget_reopensAtOnce() public {
        bytes32 key = bytes32("solo2");
        (UsdCurveV6 curve,) = _solo(key);
        vm.prank(alice);
        curve.buy(2_000e6, 0, alice);
        vm.prank(keeper);
        b.hub.freeze(key, "");
        // Trading again right away.
        vm.prank(alice);
        curve.buy(1e6, 0, alice);
        (,, uint64 round,) = b.hub.localOf(key);
        assertEq(round, 1);
    }
}
