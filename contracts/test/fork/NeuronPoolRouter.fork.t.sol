// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";
import {NeuronV4Migrator, ICurveRegistry} from "../../src/curve/NeuronV4Migrator.sol";
import {NeuronPoolRouter, IGraduatedPools} from "../../src/curve/NeuronPoolRouter.sol";

/// Refuses native coin, to check refunds and payouts to such callers.
contract NoEth {
    receive() external payable {
        revert("no");
    }
}

/**
 * @notice Trading graduated coins in their locked pools, on a fork of
 * Robinhood Chain mainnet (real PoolManager and PositionManager).
 *   forge test --match-path "test/fork/Neuron*" --fork-url robinhood
 */
contract NeuronPoolRouterForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
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

    NeuronCurve curve;
    IERC20 token;

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
        migrator = new NeuronV4Migrator(
            pm, IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), protocol, 3_000, salt
        );
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
        vm.prank(owner);
        factory.setLaunchesOpen(true);
        router = new NeuronPoolRouter(pm, IGraduatedPools(address(migrator)));

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);

        // A coin that has graduated into its locked pool.
        vm.prank(creator);
        (address c,,) = factory.launch{value: 0.2 ether}(
            "Harbor Cat", "HCAT", "", "", keccak256("k"), 0, NeuronCurve.FeeMode.Creator
        );
        curve = NeuronCurve(payable(c));
        token = IERC20(address(curve.token()));
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, alice);
        vm.prank(operator);
        curve.graduate(REPORT);
    }

    function test_fork_buyInPool() public onlyFork {
        uint256 before = bob.balance;
        vm.recordLogs();
        vm.prank(bob);
        uint256 got = router.buy{value: 0.3 ether}(address(token), 1, bob, block.timestamp);
        assertGt(got, 0);
        assertEq(token.balanceOf(bob), got);
        assertEq(before - bob.balance, 0.3 ether);
        assertEq(address(router).balance, 0, "nothing left in the router");
        assertEq(token.balanceOf(address(router)), 0);

        // The event names the real trader.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == NeuronPoolRouter.PoolTrade.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(token));
                assertEq(address(uint160(uint256(logs[i].topics[2]))), bob);
                assertEq(uint256(logs[i].topics[3]), 1); // isBuy
                (uint256 nativeAmount, uint256 tokenAmount,) = abi.decode(logs[i].data, (uint256, uint256, uint160));
                assertEq(nativeAmount, 0.3 ether);
                assertEq(tokenAmount, got);
                seen = true;
            }
        }
        assertTrue(seen, "PoolTrade emitted");
    }

    function test_fork_buyToOtherRecipient() public onlyFork {
        vm.prank(bob);
        uint256 got = router.buy{value: 0.1 ether}(address(token), 0, alice, block.timestamp);
        assertEq(token.balanceOf(alice) >= got, true);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_fork_sellInPool() public onlyFork {
        uint256 held = token.balanceOf(alice);
        uint256 amount = held / 3;
        uint256 before = alice.balance;
        vm.startPrank(alice);
        token.approve(address(router), amount);
        uint256 got = router.sell(address(token), amount, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(alice.balance - before, got);
        assertEq(token.balanceOf(alice), held - amount);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_fork_sellNeedsApproval() public onlyFork {
        vm.prank(alice);
        vm.expectRevert();
        router.sell(address(token), 1 ether, 0, alice, block.timestamp);
    }

    function test_fork_roundTripCostsAboutTwoFees() public onlyFork {
        uint256 before = bob.balance;
        vm.startPrank(bob);
        uint256 got = router.buy{value: 0.05 ether}(address(token), 0, bob, block.timestamp);
        token.approve(address(router), got);
        router.sell(address(token), got, 0, bob, block.timestamp);
        vm.stopPrank();
        uint256 lost = before - bob.balance;
        // 1% each way, plus a little price impact.
        assertGt(lost, 0.0009 ether);
        assertLt(lost, 0.0015 ether);
    }

    function test_fork_slippageProtects() public onlyFork {
        vm.prank(bob);
        vm.expectRevert();
        router.buy{value: 0.1 ether}(address(token), type(uint256).max, bob, block.timestamp);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_fork_deadline() public onlyFork {
        vm.prank(bob);
        vm.expectRevert(NeuronPoolRouter.Expired.selector);
        router.buy{value: 0.1 ether}(address(token), 0, bob, block.timestamp - 1);
    }

    function test_fork_onlyGraduatedCoins() public onlyFork {
        vm.prank(creator);
        (address c2,,) = factory.launch("Fresh", "FRSH", "", "", keccak256("k2"), 0, NeuronCurve.FeeMode.Creator);
        address t2 = address(NeuronCurve(payable(c2)).token());
        vm.prank(bob);
        vm.expectRevert(NeuronPoolRouter.NotGraduated.selector);
        router.buy{value: 0.1 ether}(t2, 0, bob, block.timestamp);
    }

    function test_fork_guards() public onlyFork {
        vm.expectRevert(NeuronPoolRouter.NotPoolManager.selector);
        router.unlockCallback("");
        vm.prank(bob);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "router refuses stray native coin");
        vm.prank(bob);
        vm.expectRevert(NeuronPoolRouter.ZeroAmount.selector);
        router.buy{value: 0}(address(token), 0, bob, block.timestamp);
        vm.prank(bob);
        vm.expectRevert(NeuronPoolRouter.ZeroAddress.selector);
        router.buy{value: 0.1 ether}(address(token), 0, address(0), block.timestamp);
    }

    function test_fork_payoutToRefusingRecipientReverts() public onlyFork {
        NoEth sink = new NoEth();
        uint256 amount = token.balanceOf(alice) / 10;
        vm.startPrank(alice);
        token.approve(address(router), amount);
        vm.expectRevert();
        router.sell(address(token), amount, 0, address(sink), block.timestamp);
        vm.stopPrank();
        // Nothing moved.
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_fork_poolFeesStillSplit() public onlyFork {
        vm.prank(bob);
        router.buy{value: 0.5 ether}(address(token), 0, bob, block.timestamp);
        (uint256 nFees,) = migrator.collectFees(address(token));
        assertApproxEqRel(nFees, 0.005 ether, 0.02e18);
    }
}
