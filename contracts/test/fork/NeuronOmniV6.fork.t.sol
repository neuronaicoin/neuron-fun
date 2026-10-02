// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {TestUSDC} from "../../src/usd/TestUSDC.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../../src/usd/UsdPoolRouter.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {IHubLocal} from "../../src/omni/ConsolidatorV6.sol";
import {MigratorV6, IV6BuybackRouter} from "../../src/omni/MigratorV6.sol";
import {MockLzEndpoint} from "../omni/MockLzEndpoint.sol";
import {FactoryStub} from "../omni/UsdCurveV6.t.sol";

/**
 * @notice v6 graduation against the real Uniswap v4 deployment on a fork of
 * Robinhood Chain mainnet: curve -> hub decision -> migrator opens the locked pool at
 * P_g -> pool trading, fees and buyback. Both coin/USDC orderings.
 *   forge test --match-path "test/fork/NeuronOmniV6*" --fork-url robinhood   (and --fork-url base)
 */
contract OmniV6ForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // Uniswap v4 and the chain's real dollar, per chain (Robinhood: USDG, Base: USDC).
    address constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant RH_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant RH_DOLLAR = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant BASE_POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address constant BASE_DOLLAR = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint32 constant EID = 30_400;
    bytes32 constant ID = bytes32("kedi");
    uint256 constant V0 = 4_500e6;
    uint256 constant T0 = 1_073_000_000 ether;
    uint256 constant TARGET = 10_000e6;

    address keeper = makeAddr("keeper");
    address protocol = makeAddr("protocol");
    address treasury = makeAddr("sasa-graduation-treasury-test");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    IPoolManager pm;
    IERC20 usdc;
    bool usdcLow;
    OmniHub hub;
    MigratorV6 migrator;
    UsdPoolRouter router;
    LaunchCoin coin;
    UsdCurveV6 curve;

    function _stack(bool lowUsdc, UsdCurveV6.FeeMode mode) internal {
        _stack(lowUsdc, mode, false);
    }

    /// `real`: the chain's real dollar (its address decides the pool ordering); otherwise a
    /// test dollar placed below or above the coin to test both orderings.
    function _stack(bool lowUsdc, UsdCurveV6.FeeMode mode, bool real) internal {
        address positionManager;
        address dollar;
        if (block.chainid == 4663) {
            pm = IPoolManager(RH_POOL_MANAGER);
            positionManager = RH_POSITION_MANAGER;
            dollar = RH_DOLLAR;
        } else if (block.chainid == 8453) {
            pm = IPoolManager(BASE_POOL_MANAGER);
            positionManager = BASE_POSITION_MANAGER;
            dollar = BASE_DOLLAR;
        } else {
            vm.skip(true);
        }
        if (real) {
            usdc = IERC20(dollar);
        } else {
            bytes32 initHash = keccak256(type(TestUSDC).creationCode);
            bytes32 salt;
            for (uint256 i;; ++i) {
                address a = vm.computeCreate2Address(bytes32(i), initHash, address(this));
                if (lowUsdc ? uint160(a) < (uint160(1) << 156) : uint160(a) > (type(uint160).max - (uint160(1) << 156))) {
                    salt = bytes32(i);
                    break;
                }
            }
            usdc = IERC20(address(new TestUSDC{salt: salt}()));
        }
        MockLzEndpoint ep = new MockLzEndpoint(EID);
        hub = new OmniHub(address(ep), address(this), EID, EID); // single-chain coin: this hub coordinates
        hub.setKeeper(keeper);
        hub.setFactory(address(this));

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
        migrator = new MigratorV6(
            pm, IPositionManager(positionManager), IAllowanceTransfer(PERMIT2), usdc, IHubLocal(address(hub)),
            makeAddr("bridge"), protocol, treasury, 3_000, hs
        );
        router = new UsdPoolRouter(pm, IUsdGraduatedPools(address(migrator)));
        migrator.bindRouter(IV6BuybackRouter(address(router)));

        coin = new LaunchCoin("Kedi", "KEDI", address(ep), 10, protocol, creator, 0, address(this));
        FactoryStub f = new FactoryStub();
        uint256 cap = T0 - (V0 * T0) / (V0 + (TARGET * 12) / 10);
        curve = f.deploy(
            UsdCurveV6.Params(IERC20(address(usdc)), coin, ID, address(f), address(hub), address(migrator), makeAddr("cons"), creator, protocol, V0, T0, cap, 100, 3_000, mode)
        );
        coin.setController(address(curve));
        usdcLow = real ? address(usdc) < address(coin) : lowUsdc;
        uint32[] memory eids = new uint32[](1);
        eids[0] = EID;
        hub.register(ID, address(curve), eids, TARGET);

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            deal(address(usdc), who, 1_000_000e6);
            vm.startPrank(who);
            usdc.approve(address(curve), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _graduate() internal returns (uint256 total, uint256 pool) {
        vm.prank(alice);
        curve.buy(10_500e6, 0, alice);
        // One chain only: the hub decides inside the freeze itself (no finalize, no messages).
        total = curve.realNative();
        uint256 v0 = curve.initialVirtualNative();
        uint256 t0 = curve.initialVirtualToken();
        pool = (total * t0 / (v0 + total)) * v0 / (v0 + total);
        uint256 sold = curve.sold();
        if (sold + pool > 1_000_000_000 ether) pool = 1_000_000_000 ether - sold;
        vm.prank(keeper);
        hub.freeze(ID, "");
        assertTrue(migrator.ready(ID), "all money here: ready at once");
        migrator.open(ID);
    }

    function _flow(bool lowWanted) internal {
        _flow(lowWanted, false);
    }

    function _flow(bool lowWanted, bool real) internal {
        _stack(lowWanted, UsdCurveV6.FeeMode.Creator, real);
        bool low = usdcLow;
        // Measure the change: on a real chain the treasury address may already hold dollars.
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        (uint256 total, uint256 pool) = _graduate();
        PoolKey memory key = migrator.poolKeyFor(address(coin));
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        assertGt(sqrtP, 0, "pool opened");
        assertGt(pm.getLiquidity(key.toId()), 0, "liquidity locked");
        assertEq(migrator.usdcIsCurrency0(address(coin)), low, "ordering as intended");
        // Opening price = P_g = total / pool coins.
        uint256 priceX18 = low
            ? (uint256(1e18) * (uint256(sqrtP) * uint256(sqrtP) >> 96)) >> 96 // coins per USDC unit
            : 0;
        if (low) assertApproxEqRel(priceX18, (pool * 1e18) / total, 0.001e18, "opening price = P_g");
        assertLe(coin.totalSupply(), 1_000_000_000 ether, "supply cap");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, (total * 200) / 10_000, "2% graduation fee to the treasury");
        assertEq(usdc.balanceOf(address(curve)), curve.creatorFees() + curve.protocolFees(), "curve keeps only fees");

        vm.startPrank(bob);
        uint256 got = router.buy(address(coin), 500e6, 1, bob, block.timestamp);
        assertEq(coin.balanceOf(bob), got);
        coin.approve(address(router), got);
        uint256 back = router.sell(address(coin), got, 1, bob, block.timestamp);
        vm.stopPrank();
        assertApproxEqRel(back, 490e6, 0.01e18, "round trip costs ~2%");

        uint256 cb = usdc.balanceOf(creator);
        uint256 pb = usdc.balanceOf(protocol);
        (uint256 uf,) = migrator.collectFees(address(coin));
        assertGt(uf, 0, "pool fees earned");
        assertEq(usdc.balanceOf(creator) - cb, (uf * 3_000) / 10_000);
        assertEq(usdc.balanceOf(protocol) - pb, uf - (uf * 3_000) / 10_000);
    }

    function test_fork_flow_usdcLow() public {
        _flow(true);
    }

    function test_fork_flow_usdcHigh() public {
        _flow(false);
    }

    /// The chain's real dollar end to end: USDG on Robinhood, Circle USDC on Base.
    function test_fork_flow_realDollar() public {
        _flow(false, true);
    }

    function test_fork_buybackMode() public {
        _stack(true, UsdCurveV6.FeeMode.Buyback);
        _graduate();
        curve.claimCreatorFees(); // curve-side buyback share goes to the migrator
        vm.prank(bob);
        router.buy(address(coin), 2_000e6, 1, bob, block.timestamp);
        migrator.collectFees(address(coin));
        uint256 supplyBefore = coin.totalSupply();
        (uint256 spent, uint256 burned) = migrator.buyback(address(coin));
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(coin.totalSupply(), supplyBefore - burned, "bought coins are burned");
    }
}
