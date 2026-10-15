// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../src/omni/AcrossUsdBridge.sol";
import {DecUsd} from "./AcrossUsdBridge.t.sol";

/// One chain's Across SpokePool: keeps deposits, and `fill` plays a relayer paying a bridge on
/// this chain and calling it, like the real pool does.
contract ChainSpoke is IAcrossSpokePool {
    struct Dep {
        address recipient;
        address outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 dstChainId;
        bytes message;
    }

    Dep[] public deps;

    function depositV3Now(address, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 dst, address, uint32, uint32, bytes calldata message)
        external
        payable
    {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        deps.push(Dep(recipient, outputToken, inputAmount, outputAmount, dst, message));
    }

    function count() external view returns (uint256) {
        return deps.length;
    }

    function last() external view returns (Dep memory) {
        return deps[deps.length - 1];
    }

    function fill(DecUsd token, AcrossUsdBridge to, uint256 amount, bytes calldata message) external {
        token.mint(address(to), amount);
        to.handleV3AcrossMessage(address(token), amount, address(0xF111), message);
    }

    function refund(DecUsd token, address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}

contract RecordingMigrator {
    bytes32 public coin;
    uint256 public amount;
    bool public buyback;
    uint256 public calls;

    function receiveConsolidated(bytes32 c, uint256 a, bool b) external {
        (coin, amount, buyback) = (c, a, b);
        calls++;
    }
}

/// BNB Chain (18-decimal USDC) and Robinhood Chain (USDG) have no Across dollar route between
/// them: their money goes through Base. Three chains are simulated side by side.
contract AcrossHopTest is Test {
    uint32 constant BASE = 30184;
    uint32 constant BNB = 30102;
    uint32 constant HOOD = 30416;
    uint32 constant ARC = 30417;
    bytes32 constant COIN = bytes32(uint256(0xC01));
    address constant KEEPER = address(0xBEE);

    struct Lane {
        DecUsd usd;
        ChainSpoke spoke;
        AcrossUsdBridge bridge;
        RecordingMigrator migrator;
        uint256 chainId;
    }

    Lane base;
    Lane bnb;
    Lane hood;

    function _chain(uint8 dec, uint256 chainId) internal returns (Lane memory c) {
        c.usd = new DecUsd(dec);
        c.spoke = new ChainSpoke();
        c.bridge = new AcrossUsdBridge(c.spoke, IERC20(address(c.usd)), address(this));
        c.migrator = new RecordingMigrator();
        c.chainId = chainId;
    }

    function _direct(Lane memory c) internal view returns (AcrossUsdBridge.Route memory) {
        return AcrossUsdBridge.Route(c.chainId, address(c.usd), address(c.bridge), c.usd.decimals(), false);
    }

    function _via(Lane memory mid) internal view returns (AcrossUsdBridge.Route memory) {
        return AcrossUsdBridge.Route(mid.chainId, address(mid.usd), address(mid.bridge), mid.usd.decimals(), true);
    }

    function _setup(Lane memory c, uint32[] memory eids, AcrossUsdBridge.Route[] memory rs) internal {
        // this test contract is every chain's consolidator
        c.bridge.setup(address(this), address(c.migrator), eids, rs);
    }

    function setUp() public {
        base = _chain(6, 8453);
        bnb = _chain(18, 56);
        hood = _chain(6, 4663);

        uint32[] memory e = new uint32[](2);
        AcrossUsdBridge.Route[] memory r = new AcrossUsdBridge.Route[](2);
        // Base: direct to both
        (e[0], e[1]) = (BNB, HOOD);
        (r[0], r[1]) = (_direct(bnb), _direct(hood));
        _setup(base, e, r);
        // BNB Chain: direct to Base, Robinhood through Base
        (e[0], e[1]) = (BASE, HOOD);
        (r[0], r[1]) = (_direct(base), _via(base));
        _setup(bnb, e, r);
        // Robinhood Chain: direct to Base, BNB Chain through Base
        (e[0], e[1]) = (BASE, BNB);
        (r[0], r[1]) = (_direct(base), _via(base));
        _setup(hood, e, r);
    }

    function _consolidate(Lane memory c, uint32 dst, uint256 amount, bool buyback) internal {
        c.usd.mint(address(this), amount);
        c.usd.approve(address(c.bridge), amount);
        c.bridge.send(dst, COIN, amount, buyback, address(this));
    }

    /// Plays the relayer for the newest deposit on `from`, landing on `to`.
    function _relay(Lane memory from, Lane memory to) internal {
        ChainSpoke.Dep memory d = from.spoke.last();
        assertEq(d.recipient, address(to.bridge), "deposit goes to the wrong bridge");
        assertEq(d.outputToken, address(to.usd), "deposit asks for the wrong token");
        assertEq(d.dstChainId, to.chainId, "deposit goes to the wrong chain");
        to.spoke.fill(to.usd, to.bridge, d.outputAmount, d.message);
    }

    // ------------------------------------------------------------ the full two-step trip

    function test_bnbToRobinhood_throughBase() public {
        _consolidate(bnb, HOOD, 1_000e18, false);
        // leg 1: BNB Chain -> Base, $999 asked in Base's 6 decimals
        ChainSpoke.Dep memory d1 = bnb.spoke.last();
        assertEq(d1.inputAmount, 1_000e18);
        assertEq(d1.outputAmount, 999e6);
        assertEq(abi.decode(_word(d1.message, 2), (uint32)), HOOD, "message must name the final chain");
        _relay(bnb, base);

        // the money waits on Base as a hop, nothing reached a migrator yet
        assertEq(base.bridge.hopsCount(), 1);
        assertEq(base.migrator.calls(), 0);
        assertEq(base.usd.balanceOf(address(base.bridge)), 999e6);

        // leg 2: anyone forwards it; the caller gets 5 cents for the gas
        vm.prank(KEEPER);
        base.bridge.forwardHop(0);
        assertEq(base.usd.balanceOf(KEEPER), 0.05e6);
        assertEq(base.usd.balanceOf(address(base.bridge)), 0);
        ChainSpoke.Dep memory d2 = base.spoke.last();
        assertEq(d2.inputAmount, 998.95e6);
        assertEq(d2.outputAmount, (uint256(998.95e6) * 9_990) / 10_000);
        assertEq(abi.decode(_word(d2.message, 2), (uint32)), 0, "second leg delivers");
        _relay(base, hood);

        // it reaches the coin on Robinhood Chain
        assertEq(hood.migrator.calls(), 1);
        assertEq(hood.migrator.coin(), COIN);
        assertEq(hood.migrator.amount(), d2.outputAmount);
        assertFalse(hood.migrator.buyback());
        assertEq(hood.usd.balanceOf(address(hood.migrator)), d2.outputAmount);
    }

    function test_robinhoodToBnb_throughBase() public {
        _consolidate(hood, BNB, 500e6, true);
        ChainSpoke.Dep memory d1 = hood.spoke.last();
        assertEq(d1.outputAmount, 499.5e6); // Base USDC, 6 decimals
        _relay(hood, base);
        base.bridge.forwardHop(0);
        ChainSpoke.Dep memory d2 = base.spoke.last();
        assertEq(d2.inputAmount, 499.45e6);
        assertEq(d2.outputAmount, ((uint256(499.45e6) * 9_990) / 10_000) * 1e12); // BNB Chain USDC, 18 decimals
        _relay(base, bnb);
        assertEq(bnb.migrator.calls(), 1);
        assertTrue(bnb.migrator.buyback(), "buyback flag must survive both legs");
        assertEq(bnb.migrator.amount(), d2.outputAmount);
    }

    /// Routes that are direct keep working exactly as before (one leg, no hop).
    function test_directRouteUnchanged() public {
        _consolidate(bnb, BASE, 100e18, false);
        assertEq(abi.decode(_word(bnb.spoke.last().message, 2), (uint32)), 0);
        _relay(bnb, base);
        assertEq(base.bridge.hopsCount(), 0);
        assertEq(base.migrator.calls(), 1);
        assertEq(base.migrator.amount(), 99.9e6);
    }

    // ------------------------------------------------------------ safety

    function test_forwardOnlyOnce() public {
        _consolidate(bnb, HOOD, 100e18, false);
        _relay(bnb, base);
        base.bridge.forwardHop(0);
        vm.expectRevert(AcrossUsdBridge.AlreadyForwarded.selector);
        base.bridge.forwardHop(0);
    }

    function test_forwardUnknownHopReverts() public {
        vm.expectRevert();
        base.bridge.forwardHop(0);
    }

    /// A hop whose final chain isn't a direct route from the middle bridge is refused, so Across
    /// never fills it and the money goes back to the sender.
    function test_hopToUnknownChainRefused() public {
        vm.expectRevert(AcrossUsdBridge.UnknownRoute.selector);
        base.spoke.fill(base.usd, base.bridge, 10e6, abi.encode(COIN, false, ARC));
    }

    /// No hop of a hop: a final chain that is itself a two-step route is refused.
    function test_hopToTwoStepRouteRefused() public {
        vm.expectRevert(AcrossUsdBridge.UnknownRoute.selector);
        bnb.spoke.fill(bnb.usd, bnb.bridge, 10e18, abi.encode(COIN, false, HOOD));
    }

    function test_onlySpokeCanDeliver() public {
        vm.expectRevert(AcrossUsdBridge.NotSpokePool.selector);
        base.bridge.handleV3AcrossMessage(address(base.usd), 1e6, address(0), abi.encode(COIN, false, HOOD));
    }

    /// A two-step route's middle must be one of the bridge's direct routes.
    function test_setupRejectsHopThroughUnknownChain() public {
        Lane memory c = _chain(18, 56);
        uint32[] memory e = new uint32[](1);
        AcrossUsdBridge.Route[] memory r = new AcrossUsdBridge.Route[](1);
        e[0] = HOOD;
        r[0] = _via(base); // Base itself is not a route of this bridge
        vm.expectRevert(AcrossUsdBridge.UnknownRoute.selector);
        c.bridge.setup(address(this), address(c.migrator), e, r);
    }

    function test_setupRejectsHopThroughWrongTwin() public {
        Lane memory c = _chain(18, 56);
        uint32[] memory e = new uint32[](2);
        AcrossUsdBridge.Route[] memory r = new AcrossUsdBridge.Route[](2);
        (e[0], e[1]) = (BASE, HOOD);
        r[0] = _direct(base);
        r[1] = AcrossUsdBridge.Route(8453, address(base.usd), address(0xDEAD), 6, true);
        vm.expectRevert(AcrossUsdBridge.UnknownRoute.selector);
        c.bridge.setup(address(this), address(c.migrator), e, r);
    }

    // ------------------------------------------------------------ tip

    function test_tipIsOnePercentForSmallHops() public view {
        assertEq(base.bridge.tipFor(2e6), 0.02e6); // $2 hop -> 2 cents
        assertEq(base.bridge.tipFor(5e6), 0.05e6); // $5 -> 5 cents
        assertEq(base.bridge.tipFor(1_000_000e6), 0.05e6); // never above 5 cents
        assertEq(base.bridge.tipFor(0), 0);
    }

    function test_tipIn18Decimals() public view {
        assertEq(bnb.bridge.tipFor(1_000e18), 0.05e18);
    }

    // ------------------------------------------------------------ refunds

    /// Second leg never filled: Across refunds the middle bridge and the owner sends it again,
    /// to the same coin on the same final chain.
    function test_secondLegRefundResent() public {
        _consolidate(bnb, HOOD, 100e18, false);
        _relay(bnb, base);
        base.bridge.forwardHop(0);
        uint256 sid = base.bridge.sendsCount() - 1;
        (uint32 dst,,, bytes32 coin, uint256 amt) = base.bridge.sends(sid);
        assertEq(dst, HOOD);
        assertEq(coin, COIN);
        base.spoke.refund(base.usd, address(base.bridge), amt);
        base.bridge.resend(sid, 50);
        ChainSpoke.Dep memory d = base.spoke.last();
        assertEq(d.dstChainId, 4663);
        assertEq(d.inputAmount, amt);
        _relay(base, hood);
        assertEq(hood.migrator.calls(), 1);
    }

    /// First leg never filled: refunded on BNB Chain, resent, still goes through Base to Robinhood.
    function test_firstLegRefundResent() public {
        _consolidate(bnb, HOOD, 100e18, false);
        bnb.spoke.refund(bnb.usd, address(bnb.bridge), 100e18);
        bnb.bridge.resend(0, 20);
        ChainSpoke.Dep memory d = bnb.spoke.last();
        assertEq(d.dstChainId, 8453);
        assertEq(abi.decode(_word(d.message, 2), (uint32)), HOOD);
        _relay(bnb, base);
        base.bridge.forwardHop(0);
        _relay(base, hood);
        assertEq(hood.migrator.calls(), 1);
    }

    /// The owner can't send money that is waiting for a hop as if it were a refund.
    function test_resendCantUseHopMoney() public {
        // a direct send from Base that was never refunded
        _consolidate(base, BNB, 100e6, false);
        // meanwhile a hop lands on Base
        _consolidate(bnb, HOOD, 500e18, false);
        _relay(bnb, base);
        assertEq(base.bridge.waitingForHops(), 499.5e6);
        vm.expectRevert(AcrossUsdBridge.NotRefunded.selector);
        base.bridge.resend(0, 10);
        // once forwarded, nothing is counted as waiting
        base.bridge.forwardHop(0);
        assertEq(base.bridge.waitingForHops(), 0);
        // a real refund of the first send can go again
        base.spoke.refund(base.usd, address(base.bridge), 100e6);
        base.bridge.resend(0, 10);
    }

    // ------------------------------------------------------------ fuzz

    /// Across both legs, what arrives is never more than what left, and never short by more
    /// than the two fees, the tip and rounding.
    function testFuzz_bnbToRobinhoodValue(uint256 amount, uint256 bps) public {
        amount = bound(amount, 1e15, 1e30); // $0.001 .. $1e12
        bps = bound(bps, 0, 50);
        bnb.bridge.setFeeBps(bps);
        base.bridge.setFeeBps(bps);
        _consolidate(bnb, HOOD, amount, false);
        _relay(bnb, base);
        uint256 landed = base.usd.balanceOf(address(base.bridge));
        base.bridge.forwardHop(0);
        uint256 tip = base.bridge.tipFor(landed);
        if (base.spoke.count() == 0) {
            // under one smallest unit after the tip: stays as dust, never reverts
            assertLe(landed - tip, 1);
            return;
        }
        _relay(base, hood);
        uint256 arrived = hood.migrator.amount() * 1e12; // in 18 decimals
        assertLe(arrived, amount);
        uint256 afterFees = (((amount * (10_000 - bps)) / 10_000) * (10_000 - bps)) / 10_000;
        assertGe(arrived + tip * 1e12 + 3e12, afterFees);
        assertLe(tip, landed / 100 + 1);
    }

    // ------------------------------------------------------------ helpers

    /// Word `i` of an abi-encoded message.
    function _word(bytes memory m, uint256 i) internal pure returns (bytes memory w) {
        w = new bytes(32);
        for (uint256 k; k < 32; ++k) w[k] = m[i * 32 + k];
    }
}
