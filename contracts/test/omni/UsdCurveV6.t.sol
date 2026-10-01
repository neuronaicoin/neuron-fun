// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";

contract USDC6 is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract FactoryStub {
    bool public buysPaused;
    function setPaused(bool p) external { buysPaused = p; }
    function noteNativeIn(uint256, bool) external {}
    function noteNativeOut(uint256) external {}
    function deploy(UsdCurveV6.Params memory p) external returns (UsdCurveV6) { return new UsdCurveV6(p); }
}

contract SinkStub {
    uint256 public got;
    uint256 public handed;
    function fromCurve(bytes32, uint256 money, uint256, uint256) external { handed += money; }
    function fromCurve(bytes32, uint256 money) external { handed += money; }
    function depositBuyback(bytes32, uint256 a) external {
        got += a;
        ERC20(address(UsdCurveV6(msg.sender).quote())).transferFrom(msg.sender, address(this), a);
    }
}

contract UsdCurveV6Test is Test {
    // Mainnet numbers, 2 chains: each curve is 1/2 of the reference curve.
    uint256 constant V0 = 4_500e6;
    uint256 constant T0 = 1_073_000_000 ether;
    uint256 constant N = 2;
    uint256 constant TARGET = 10_000e6;
    USDC6 usdc;
    LaunchCoin coin;
    UsdCurveV6 curve;
    FactoryStub factory;
    address hub = address(0x4B);
    address migrator;
    address consolidator;
    address creator = address(0xC4EA);
    address proto = address(0x9407);
    address alice = address(0xA11CE);

    function saleCapFor(uint256 v, uint256 t) internal pure returns (uint256) {
        // Coins one chain sells if 120% of the whole target lands on it.
        uint256 r = (TARGET * 12) / 10;
        return t - (v * t) / (v + r);
    }

    function setUp() public {
        migrator = address(new SinkStub());
        consolidator = address(new SinkStub());
        usdc = new USDC6();
        factory = new FactoryStub();
        MockLzEndpoint ep = new MockLzEndpoint(1);
        coin = new LaunchCoin("Kedi", "KEDI", address(ep), 10, proto, creator, 0, address(this));
        uint256 v = V0 / N;
        uint256 t = T0 / N;
        curve = factory.deploy(
            UsdCurveV6.Params(usdc, coin, bytes32("kedi"), address(factory), hub, migrator, consolidator, creator, proto, v, t, saleCapFor(v, t), 100, 3_000, UsdCurveV6.FeeMode.Creator)
        );
        coin.setController(address(curve));
        coin.renounceOwnership();
        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(curve), type(uint256).max);
        vm.prank(alice);
        coin.approve(address(curve), type(uint256).max);
    }

    function test_startPriceMatchesReferenceCurve() public view {
        // Market cap at start: price * 1B = V0 / T0 * 1B ~ $4,194
        uint256 mc = (curve.virtualNative() * 1e9 ether) / curve.virtualToken();
        assertApproxEqAbs(mc, 4_193.84e6, 0.01e6);
    }

    function test_buyMintsSellBurns() public {
        vm.prank(alice);
        uint256 got = curve.buy(1_000e6, 0, alice);
        assertEq(coin.balanceOf(alice), got);
        assertEq(coin.totalSupply(), got);
        assertEq(curve.sold(), got);
        vm.prank(alice);
        uint256 back = curve.sell(got, 0, alice);
        assertEq(coin.totalSupply(), 0);
        assertEq(curve.sold(), 0);
        assertLt(back, 1_000e6); // fees both ways
        assertGt(back, 970e6);
    }

    function test_capStopsAtSaleCap_andPullsOnlyWhatIsSpent() public {
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        curve.buy(500_000e6, 0, alice);
        assertEq(curve.sold(), curve.saleCap());
        uint256 spent = before - usdc.balanceOf(alice);
        assertApproxEqRel(spent, 12_120e6, 0.01e18); // 120% of target + 1% fee
        vm.prank(alice);
        vm.expectRevert(UsdCurveV6.SoldOut.selector);
        curve.buy(1e6, 0, alice);
    }

    function test_freezeStopsEverything_reopenResumes() public {
        vm.prank(alice);
        curve.buy(100e6, 0, alice);
        vm.expectRevert(UsdCurveV6.NotHub.selector);
        curve.freeze();
        vm.prank(hub);
        (uint256 money, uint256 s) = curve.freeze();
        assertEq(money, curve.realNative());
        assertEq(s, curve.sold());
        vm.startPrank(alice);
        vm.expectRevert(UsdCurveV6.NotTrading.selector);
        curve.buy(1e6, 0, alice);
        vm.expectRevert(UsdCurveV6.NotTrading.selector);
        curve.sell(1 ether, 0, alice);
        vm.stopPrank();
        vm.prank(hub);
        curve.reopen();
        vm.prank(alice);
        curve.buy(1e6, 0, alice);
    }

    function test_settleWinner() public {
        vm.prank(alice);
        curve.buy(6_000e6, 0, alice);
        uint256 money = curve.realNative();
        uint256 fees = curve.creatorFees() + curve.protocolFees();
        vm.startPrank(hub);
        curve.freeze();
        curve.settle(7, true, 200_000_000 ether, 6_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(migrator), money);
        assertEq(coin.balanceOf(migrator), 200_000_000 ether);
        assertEq(usdc.balanceOf(address(curve)), fees); // fee money stays claimable
        assertTrue(coin.bridgeOpen());
        assertEq(coin.homeEid(), 7);
        curve.claimCreatorFees();
        curve.claimProtocolFees();
        assertEq(usdc.balanceOf(address(curve)), 0);
    }

    function test_settleLoser() public {
        vm.prank(alice);
        curve.buy(3_000e6, 0, alice);
        uint256 money = curve.realNative();
        vm.startPrank(hub);
        curve.freeze();
        curve.settle(7, false, 123 ether, 0); // pool tokens ignored on losers
        vm.stopPrank();
        assertEq(usdc.balanceOf(consolidator), money);
        assertEq(coin.balanceOf(migrator), 0);
        vm.prank(hub);
        vm.expectRevert(UsdCurveV6.NotFrozen.selector);
        curve.settle(7, false, 0, 0);
    }

    function test_settleNeedsFreeze() public {
        vm.prank(hub);
        vm.expectRevert(UsdCurveV6.NotFrozen.selector);
        curve.settle(7, true, 1, 1);
    }

    function test_pausedBlocksBuysNotSells() public {
        vm.prank(alice);
        uint256 got = curve.buy(100e6, 0, alice);
        factory.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(UsdCurveV6.BuysPaused.selector);
        curve.buy(1e6, 0, alice);
        vm.prank(alice);
        curve.sell(got, 0, alice);
    }

    /// Everyone can always sell back everything: the curve holds the money.
    function testFuzz_solvency(uint64[6] memory buys, uint8 sellPct) public {
        address[3] memory ppl = [address(0x1), address(0x2), address(0x3)];
        for (uint256 i; i < 3; ++i) {
            usdc.mint(ppl[i], 100_000e6);
            vm.startPrank(ppl[i]);
            usdc.approve(address(curve), type(uint256).max);
            coin.approve(address(curve), type(uint256).max);
            vm.stopPrank();
        }
        for (uint256 i; i < 6; ++i) {
            uint256 a = bound(uint256(buys[i]), 1e6, 5_000e6);
            if (curve.sold() == curve.saleCap()) break;
            vm.prank(ppl[i % 3]);
            curve.buy(a, 0, ppl[i % 3]);
            if (i % 2 == 1) {
                uint256 b = (coin.balanceOf(ppl[i % 3]) * bound(sellPct, 1, 100)) / 100;
                if (b > 0) {
                    vm.prank(ppl[i % 3]);
                    curve.sell(b, 0, ppl[i % 3]);
                }
            }
        }
        for (uint256 i; i < 3; ++i) {
            uint256 bal = coin.balanceOf(ppl[i]);
            if (bal > 0) {
                vm.prank(ppl[i]);
                curve.sell(bal, 0, ppl[i]);
            }
        }
        assertEq(coin.totalSupply(), 0);
        assertEq(curve.sold(), 0);
        // Only rounding dust may remain beyond the fees.
        assertLe(usdc.balanceOf(address(curve)) - curve.creatorFees() - curve.protocolFees(), 10);
        assertGe(usdc.balanceOf(address(curve)), curve.creatorFees() + curve.protocolFees());
    }

    function _buybackCurve(address mig, address cons) internal returns (UsdCurveV6 c, LaunchCoin k) {
        MockLzEndpoint ep = new MockLzEndpoint(2);
        k = new LaunchCoin("B", "B", address(ep), 10, proto, creator, 0, address(this));
        uint256 v = V0 / N;
        uint256 t = T0 / N;
        c = factory.deploy(
            UsdCurveV6.Params(usdc, k, bytes32("b"), address(factory), hub, mig, cons, creator, proto, v, t, saleCapFor(v, t), 100, 3_000, UsdCurveV6.FeeMode.Buyback)
        );
        k.setController(address(c));
        vm.prank(alice);
        usdc.approve(address(c), type(uint256).max);
    }

    function test_buyback_waitsThenGoesToPool() public {
        SinkStub mig = new SinkStub();
        (UsdCurveV6 c,) = _buybackCurve(address(mig), address(new SinkStub()));
        vm.prank(alice);
        c.buy(2_000e6, 0, alice);
        uint256 share = c.creatorFees();
        assertGt(share, 0);
        assertEq(c.claimCreatorFees(), 0); // waits before graduation
        assertEq(usdc.balanceOf(creator), 0);
        vm.startPrank(hub);
        c.freeze();
        c.settle(5, true, 1 ether, 1);
        vm.stopPrank();
        assertEq(c.claimCreatorFees(), share);
        assertEq(mig.got(), share);
        assertEq(usdc.balanceOf(creator), 0);
    }

    function test_buyback_loserForwardsToConsolidator() public {
        SinkStub cons = new SinkStub();
        (UsdCurveV6 c,) = _buybackCurve(address(new SinkStub()), address(cons));
        vm.prank(alice);
        c.buy(1_000e6, 0, alice);
        uint256 share = c.creatorFees();
        vm.startPrank(hub);
        c.freeze();
        c.settle(5, false, 0, 0);
        vm.stopPrank();
        c.claimCreatorFees();
        assertEq(cons.got(), share);
    }

    function test_buyback_fallbackToCreatorAfter30Days() public {
        (UsdCurveV6 c,) = _buybackCurve(address(new SinkStub()), address(new SinkStub()));
        vm.prank(alice);
        c.buy(1_000e6, 0, alice);
        uint256 share = c.creatorFees();
        vm.warp(block.timestamp + 30 days);
        c.claimCreatorFees();
        assertEq(usdc.balanceOf(creator), share);
    }
}
