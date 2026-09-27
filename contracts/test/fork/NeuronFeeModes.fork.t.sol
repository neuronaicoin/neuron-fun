// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";
import {NeuronV4Migrator, ICurveRegistry, IBuybackRouter} from "../../src/curve/NeuronV4Migrator.sol";
import {NeuronPoolRouter, IGraduatedPools} from "../../src/curve/NeuronPoolRouter.sol";

/**
 * @notice Fee modes after graduation, on a fork of Robinhood Chain mainnet:
 * the migrator routes the creator's share of pool fees by mode.
 */
contract NeuronFeeModesForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant REPORT = keccak256("tally");

    IPoolManager pm = IPoolManager(POOL_MANAGER);
    NeuronV4Migrator migrator;
    NeuronCurveFactory factory;
    NeuronPoolRouter router;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address protocol = makeAddr("protocol");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    modifier onlyFork() {
        if (block.chainid != 4663) vm.skip(true);
        _;
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 initHash =
            keccak256(abi.encodePacked(type(NeuronGraduationHook).creationCode, abi.encode(POOL_MANAGER, predicted)));
        bytes32 salt;
        for (uint256 i;; ++i) {
            address h = vm.computeCreate2Address(bytes32(i), initHash, predicted);
            if (uint160(h) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_INITIALIZE_FLAG) {
                salt = bytes32(i);
                break;
            }
        }
        migrator = new NeuronV4Migrator(pm, IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), protocol, 3_000, salt);
        factory = new NeuronCurveFactory(
            owner,
            migrator,
            operator,
            protocol,
            NeuronCurveFactory.Config({
                virtualNative: 1 ether,
                virtualToken: 1_073_000_000 ether,
                tokensForSale: 793_100_000 ether,
                graduationTokens: 206_900_000 ether,
                feeBps: 100,
                creatorShareBps: 3_000,
                minGraduationNative: 0.5 ether
            })
        );
        migrator.bindCurves(ICurveRegistry(address(factory)));
        router = new NeuronPoolRouter(pm, IGraduatedPools(address(migrator)));
        migrator.bindRouter(IBuybackRouter(address(router)));
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _graduated(NeuronCurve.FeeMode mode) internal returns (NeuronCurve c, CurveToken t) {
        vm.prank(creator);
        (address a,,) = factory.launch{value: 0.2 ether}("Harbor Cat", "HCAT", "", "", keccak256(abi.encode(mode)), 0, mode);
        c = NeuronCurve(payable(a));
        t = c.token();
        vm.prank(alice);
        c.buy{value: 1 ether}(0, alice);
        vm.prank(operator);
        c.graduate(REPORT);
    }

    /// Volume in the pool: bob buys, then sells part back (fees in both coins).
    function _poolVolume(CurveToken t) internal {
        vm.startPrank(bob);
        uint256 got = router.buy{value: 2 ether}(address(t), 0, bob, block.timestamp);
        t.approve(address(router), got / 2);
        router.sell(address(t), got / 2, 0, bob, block.timestamp);
        vm.stopPrank();
    }

    function test_fork_modeCopiedAtGraduation() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Holders);
        assertEq(uint256(migrator.feeModes(address(t))), uint256(NeuronCurve.FeeMode.Holders));
    }

    function test_fork_poolManagerEarnsNothing() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Holders);
        assertTrue(t.excluded(POOL_MANAGER));
        assertGt(t.balanceOf(POOL_MANAGER), 0, "pool holds liquidity");
        assertEq(t.earned(POOL_MANAGER), 0);
    }

    function test_fork_creatorMode_unchanged() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Creator);
        _poolVolume(t);
        uint256 nBefore = creator.balance;
        uint256 tBefore = t.balanceOf(creator);
        (uint256 nFees, uint256 tFees) = migrator.collectFees(address(t));
        assertApproxEqAbs(creator.balance - nBefore, (nFees * 3_000) / 10_000, 1);
        assertApproxEqAbs(t.balanceOf(creator) - tBefore, (tFees * 3_000) / 10_000, 1);
    }

    function test_fork_holdersMode_poolFeesGoToHolders() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Holders);
        _poolVolume(t);
        uint256 before = t.totalDistributed();
        uint256 deadBefore = t.balanceOf(DEAD);
        uint256 creatorBefore = creator.balance;
        (uint256 nFees, uint256 tFees) = migrator.collectFees(address(t));
        assertGt(nFees, 0);
        assertApproxEqAbs(t.totalDistributed() - before, (nFees * 3_000) / 10_000, 1, "native share to holders");
        assertApproxEqAbs(t.balanceOf(DEAD) - deadBefore, (tFees * 3_000) / 10_000, 1, "token share burned");
        assertEq(creator.balance, creatorBefore, "creator gets nothing directly");
        // Holders can claim it.
        uint256 owed = t.claimable(alice);
        assertGt(owed, 0);
        vm.prank(alice);
        assertEq(t.claim(alice), owed);
    }

    function test_fork_buyback_fundAndBurnInPool() public onlyFork {
        (NeuronCurve c, CurveToken t) = _graduated(NeuronCurve.FeeMode.Buyback);
        // The curve's leftover buyback money moves to the migrator.
        uint256 leftover = c.creatorFees();
        c.claimCreatorFees();
        assertEq(migrator.buybackFunds(address(t)), leftover);

        _poolVolume(t);
        (uint256 nFees,) = migrator.collectFees(address(t));
        uint256 fund = migrator.buybackFunds(address(t));
        assertApproxEqAbs(fund, leftover + (nFees * 3_000) / 10_000, 1);

        uint256 deadBefore = t.balanceOf(DEAD);
        vm.prank(bob); // anyone can run it
        (uint256 spent, uint256 burned) = migrator.buyback(address(t));
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(t.balanceOf(DEAD) - deadBefore, burned, "burned");
        assertEq(migrator.buybackFunds(address(t)), fund - spent);
    }

    function test_fork_buyback_chunkIsCapped() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Buyback);
        // A big donation to the fund: one call spends at most one chunk.
        migrator.depositBuyback{value: 5 ether}(address(t));
        (uint256 spent,) = migrator.buyback(address(t));
        assertLt(spent, 0.05 ether, "about 0.5% of the pool's native side");
        assertEq(migrator.buybackFunds(address(t)), 5 ether - spent);
        // And again.
        (uint256 spent2,) = migrator.buyback(address(t));
        assertGt(spent2, 0);
    }

    function test_fork_buyback_needsFunds() public onlyFork {
        (, CurveToken t) = _graduated(NeuronCurve.FeeMode.Buyback);
        vm.expectRevert(NeuronV4Migrator.NothingToBuyBack.selector);
        migrator.buyback(address(t));
    }

    function test_fork_routerBindsOnce() public onlyFork {
        vm.expectRevert(NeuronV4Migrator.AlreadyBound.selector);
        migrator.bindRouter(IBuybackRouter(address(router)));
        vm.prank(alice);
        vm.expectRevert(NeuronV4Migrator.NotDeployer.selector);
        migrator.bindRouter(IBuybackRouter(address(router)));
    }
}
