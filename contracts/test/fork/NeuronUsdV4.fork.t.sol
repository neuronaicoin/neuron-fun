// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary, PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {TestUSDC} from "../../src/usd/TestUSDC.sol";
import {UsdCurve} from "../../src/usd/UsdCurve.sol";
import {UsdToken} from "../../src/usd/UsdToken.sol";
import {UsdCurveFactory} from "../../src/usd/UsdCurveFactory.sol";
import {UsdV4Migrator, IUsdCurveRegistry, IUsdBuybackRouter} from "../../src/usd/UsdV4Migrator.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../../src/usd/UsdPoolRouter.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";

/**
 * @notice The USD (v5) pool side against the real Uniswap v4 deployment, on a
 * fork of Robinhood Chain mainnet (real PoolManager, PositionManager, Permit2).
 * Both coin/USDC orderings are covered.
 *   forge test --match-path "test/fork/NeuronUsd*" --fork-url robinhood
 */
contract NeuronUsdV4ForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    bytes32 constant REPORT = keccak256("tally");
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    IPoolManager pm;
    TestUSDC usdc;
    UsdV4Migrator migrator;
    UsdCurveFactory factory;
    UsdPoolRouter router;

    /// @param lowUsdc put USDC at a very low address (USDC = currency0) or a very high one (currency1)
    function _stack(bool lowUsdc) internal {
        if (block.chainid != 4663) vm.skip(true);
        pm = IPoolManager(POOL_MANAGER);
        // USDC at a chosen end of the address space, via CREATE2.
        bytes32 initHash = keccak256(type(TestUSDC).creationCode);
        bytes32 salt;
        for (uint256 i;; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initHash, address(this));
            if (lowUsdc ? uint160(a) < (uint160(1) << 156) : uint160(a) > (type(uint160).max - (uint160(1) << 156))) {
                salt = bytes32(i);
                break;
            }
        }
        usdc = new TestUSDC{salt: salt}();
        // Hook salt for the migrator deployed next.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 hookHash = keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(address(pm), predicted)));
        bytes32 hs;
        for (uint256 i;; ++i) {
            address h = vm.computeCreate2Address(bytes32(i), hookHash, predicted);
            if (uint160(h) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_INITIALIZE_FLAG) {
                hs = bytes32(i);
                break;
            }
        }
        migrator = new UsdV4Migrator(pm, IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), IERC20(address(usdc)), protocol, 3_000, hs);
        factory = new UsdCurveFactory(
            owner,
            migrator,
            operator,
            protocol,
            UsdCurveFactory.Config({
                virtualNative: 1_000e6,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 1_000e6
            }),
            IERC20(address(usdc))
        );
        migrator.bindCurves(IUsdCurveRegistry(address(factory)));
        router = new UsdPoolRouter(pm, IUsdGraduatedPools(address(migrator)));
        migrator.bindRouter(IUsdBuybackRouter(address(router)));
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        for (uint256 i; i < 3; ++i) {
            address w = [creator, alice, bob][i];
            deal(address(usdc), w, 1_000_000e6);
            vm.startPrank(w);
            usdc.approve(address(factory), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _graduated(UsdCurve.FeeMode mode) internal returns (UsdCurve c, UsdToken t) {
        vm.prank(creator);
        (address curve,,) = factory.launch("Cat", "CAT", "", "", "k", 50e6, 0, mode);
        c = UsdCurve(curve);
        t = c.token();
        vm.startPrank(alice);
        usdc.approve(curve, type(uint256).max);
        c.buy(3_000e6, 0, alice);
        vm.stopPrank();
        uint256 lastPriceNum = c.virtualToken(); // tokens per USDC = vT / vN
        uint256 lastPriceDen = c.virtualNative();
        vm.prank(operator);
        c.graduate(REPORT);
        // Pool price equals the curve's last price (within 0.1%).
        PoolKey memory key = migrator.poolKeyFor(address(t));
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        assertGt(sqrtP, 0, "pool opened");
        uint256 p = uint256(sqrtP) * uint256(sqrtP) >> 96; // amount1/amount0 * 2^96
        bool u0 = migrator.usdcIsCurrency0(address(t));
        // tokens per USDC, times 2^96
        uint256 tokPerUsdc = u0 ? p : (uint256(1) << 192) / p;
        uint256 want = (lastPriceNum << 96) / lastPriceDen;
        assertApproxEqRel(tokPerUsdc, want, 0.001e18, "opening price = curve price");
        assertGt(pm.getLiquidity(key.toId()), 0, "liquidity locked");
    }

    function _roundTrip(bool low) internal {
        _stack(low);
        (UsdCurve c, UsdToken t) = _graduated(UsdCurve.FeeMode.Creator);
        assertEq(migrator.usdcIsCurrency0(address(t)), low, "ordering as intended");
        assertEq(usdc.balanceOf(address(c)), c.creatorFees() + c.protocolFees(), "curve keeps only fees");

        // bob buys $500 in the pool
        uint256 u0 = usdc.balanceOf(bob);
        vm.prank(bob);
        uint256 got = router.buy(address(t), 500e6, 1, bob, block.timestamp);
        assertEq(u0 - usdc.balanceOf(bob), 500e6, "pulled exactly what was spent");
        assertEq(t.balanceOf(bob), got);
        assertEq(usdc.balanceOf(address(router)), 0);
        // and sells it back: loses about 2% (1% each way), not more
        vm.startPrank(bob);
        t.approve(address(router), got);
        uint256 back = router.sell(address(t), got, 1, bob, block.timestamp);
        vm.stopPrank();
        assertApproxEqRel(back, 490e6, 0.01e18, "round trip costs ~2%");
        assertEq(t.balanceOf(address(router)), 0);

        // slippage protection
        vm.prank(bob);
        vm.expectRevert();
        router.buy(address(t), 100e6, type(uint256).max, bob, block.timestamp);

        // fees: creator gets 30% of USDC fees, protocol 70%
        uint256 cb = usdc.balanceOf(creator);
        uint256 pb = usdc.balanceOf(protocol);
        (uint256 uf,) = migrator.collectFees(address(t));
        assertGt(uf, 0, "the buy earned USDC fees");
        assertEq(usdc.balanceOf(creator) - cb, (uf * 3_000) / 10_000);
        assertEq(usdc.balanceOf(protocol) - pb, uf - (uf * 3_000) / 10_000);
    }

    function test_usdcCurrency0_fullLifecycle() public {
        _roundTrip(true);
    }

    function test_usdcCurrency1_fullLifecycle() public {
        _roundTrip(false);
    }

    function _buybackMode(bool low) internal {
        _stack(low);
        (UsdCurve c, UsdToken t) = _graduated(UsdCurve.FeeMode.Buyback);
        // trading in the pool builds a buyback fund
        vm.prank(bob);
        router.buy(address(t), 20_000e6, 1, bob, block.timestamp);
        migrator.collectFees(address(t));
        uint256 fund = migrator.buybackFunds(address(t));
        assertGt(fund, 0);
        uint256 deadBefore = t.balanceOf(migrator.DEAD());
        (uint256 spent, uint256 burned) = migrator.buyback(address(t));
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(t.balanceOf(migrator.DEAD()) - deadBefore, burned, "bought coins are burned");
        assertEq(migrator.buybackFunds(address(t)), fund - spent);
        c; // silence
    }

    function test_buyback_usdcCurrency0() public {
        _buybackMode(true);
    }

    function test_buyback_usdcCurrency1() public {
        _buybackMode(false);
    }

    function test_holdersMode_poolFeesGoToHolders() public {
        _stack(true);
        (, UsdToken t) = _graduated(UsdCurve.FeeMode.Holders);
        vm.prank(bob);
        router.buy(address(t), 20_000e6, 1, bob, block.timestamp);
        uint256 before = t.totalDistributed() + t.pendingRewards();
        migrator.collectFees(address(t));
        assertGt(t.totalDistributed() + t.pendingRewards(), before, "holders got USDC");
        uint256 cl = t.claimable(alice);
        if (cl > 0) {
            uint256 ub = usdc.balanceOf(alice);
            vm.prank(alice);
            t.claim(alice);
            assertEq(usdc.balanceOf(alice) - ub, cl);
        }
    }

    function test_onlyCurvesCanMigrate() public {
        _stack(true);
        vm.expectRevert(UsdV4Migrator.NotACurve.selector);
        migrator.migrate(address(usdc), 1, 1);
    }

    function test_poolRouter_refusesUngraduated() public {
        _stack(true);
        vm.prank(creator);
        (address curve,,) = factory.launch("Cat", "CAT", "", "", "k", 50e6, 0, UsdCurve.FeeMode.Creator);
        address tok = address(UsdCurve(curve).token());
        vm.prank(bob);
        vm.expectRevert(UsdPoolRouter.NotGraduated.selector);
        router.buy(tok, 10e6, 1, bob, block.timestamp);
    }
}
