// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {NeuronCurve} from "../../src/curve/NeuronCurve.sol";
import {NeuronCurveFactory} from "../../src/curve/NeuronCurveFactory.sol";
import {NeuronGraduationHook} from "../../src/curve/NeuronGraduationHook.sol";
import {NeuronV4Migrator, ICurveRegistry} from "../../src/curve/NeuronV4Migrator.sol";

/// Minimal exact-input swapper straight against the PoolManager.
contract V4Swapper is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) external payable returns (BalanceDelta d) {
        d = abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountIn, msg.sender)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address user) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        BalanceDelta d = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 < 0) pm.settle{value: uint128(-a0)}();
        if (a1 < 0) {
            pm.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transferFrom(user, address(pm), uint128(-a1));
            pm.settle();
        }
        if (a0 > 0) pm.take(key.currency0, user, uint128(a0));
        if (a1 > 0) pm.take(key.currency1, user, uint128(a1));
        // Give back unused native coin.
        if (address(this).balance > 0) payable(user).transfer(address(this).balance);
        return abi.encode(d);
    }
}

/**
 * @notice A curve graduating into a locked Uniswap v4 pool, on a fork of
 * Robinhood Chain mainnet (the real PoolManager and PositionManager).
 *   forge test --match-path "test/fork/Neuron*" --fork-url robinhood
 */
contract NeuronCurveGraduationForkTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant REPORT = keccak256("tally");

    IPoolManager pm = IPoolManager(POOL_MANAGER);
    NeuronV4Migrator migrator;
    NeuronCurveFactory factory;
    V4Swapper swapper;

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

        // Find a salt that gives the hook exactly the before-initialize flag.
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
        assertEq(address(migrator), predicted);

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

        swapper = new V4Swapper(pm);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _launchAndFill() internal returns (NeuronCurve c, IERC20 t) {
        vm.prank(creator);
        (address curve,,) = factory.launch{value: 0.2 ether}("Harbor Cat", "HCAT", "", "", keccak256("k"), 0);
        c = NeuronCurve(payable(curve));
        t = IERC20(address(c.token()));
        vm.prank(alice);
        c.buy{value: 1 ether}(0, alice);
    }

    function _graduate(NeuronCurve c) internal {
        vm.prank(operator);
        c.graduate(REPORT);
    }

    function test_fork_graduationLocksLiquidityAtCurvePrice() public onlyFork {
        (NeuronCurve c, IERC20 t) = _launchAndFill();
        uint256 realNative = c.realNative();
        uint256 vN = c.virtualNative();
        uint256 vT = c.virtualToken();

        _graduate(c);

        (uint256 tokenId, address posCreator) = migrator.positions(address(t));
        assertGt(tokenId, 0);
        assertEq(posCreator, creator);
        // The position belongs to the migrator, which can never move it.
        assertEq(IERC721Min(POSITION_MANAGER).ownerOf(tokenId), address(migrator));

        // Pool price matches the curve's last price (tokens per native).
        PoolKey memory key = migrator.poolKeyFor(address(t));
        (uint160 sqrtP,,,) = pm.getSlot0(PoolId.wrap(keccak256(abi.encode(key))));
        uint256 priceX96sq = uint256(sqrtP) * uint256(sqrtP) >> 96; // tokens per native, Q96
        uint256 curvePriceX96 = (vT << 96) / vN;
        assertApproxEqRel(priceX96sq, curvePriceX96, 0.001e18);

        // Nearly all the curve's native went into the pool; only dust stays behind.
        assertLt(migrator.lockedNativeDust(), realNative / 1000);
        assertEq(t.balanceOf(address(c)), 0);
        assertEq(t.balanceOf(address(migrator)), 0);
    }

    function test_fork_nobodyElseCanCreateThePool() public onlyFork {
        (NeuronCurve c, IERC20 t) = _launchAndFill();
        PoolKey memory key = migrator.poolKeyFor(address(t));
        vm.prank(alice);
        vm.expectRevert();
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        // Graduation still works afterwards.
        _graduate(c);
    }

    function test_fork_onlyCurvesCanMigrate() public onlyFork {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(NeuronV4Migrator.NotACurve.selector);
        migrator.migrate{value: 1 ether}(address(0x1234), 1);
    }

    function test_fork_bindOnlyOnce() public onlyFork {
        vm.expectRevert(NeuronV4Migrator.AlreadyBound.selector);
        migrator.bindCurves(ICurveRegistry(address(factory)));
    }

    function test_fork_tradesAfterGraduationAndFeesSplit() public onlyFork {
        (NeuronCurve c, IERC20 t) = _launchAndFill();
        _graduate(c);
        PoolKey memory key = migrator.poolKeyFor(address(t));

        // Bob buys in the pool, alice sells some back.
        vm.prank(bob);
        swapper.swap{value: 0.5 ether}(key, true, 0.5 ether);
        uint256 bobTokens = t.balanceOf(bob);
        assertGt(bobTokens, 0);

        uint256 sellAmt = t.balanceOf(alice) / 4;
        vm.startPrank(alice);
        t.approve(address(swapper), sellAmt);
        swapper.swap(key, false, sellAmt);
        vm.stopPrank();

        uint256 creatorNative = creator.balance;
        uint256 protocolNative = protocol.balance;
        uint256 creatorTok = t.balanceOf(creator);
        uint256 protocolTok = t.balanceOf(protocol);

        vm.prank(bob); // anyone may trigger
        (uint256 nFees, uint256 tFees) = migrator.collectFees(address(t));

        // 1% of the 0.5 native buy, give or take rounding.
        assertApproxEqRel(nFees, 0.005 ether, 0.02e18);
        assertGt(tFees, 0);
        assertEq(creator.balance - creatorNative, nFees * 3_000 / 10_000);
        assertEq(protocol.balance - protocolNative, nFees - nFees * 3_000 / 10_000);
        assertEq(t.balanceOf(creator) - creatorTok, tFees * 3_000 / 10_000);
        assertEq(t.balanceOf(protocol) - protocolTok, tFees - tFees * 3_000 / 10_000);

        // Collecting again right away finds nothing.
        (nFees, tFees) = migrator.collectFees(address(t));
        assertEq(nFees, 0);
        assertEq(tFees, 0);
    }

    function test_fork_closedChainHoldersCanStillExit() public onlyFork {
        (NeuronCurve c, IERC20 t) = _launchAndFill();
        vm.prank(operator);
        c.close(REPORT);
        uint256 bal = t.balanceOf(alice);
        vm.startPrank(alice);
        t.approve(address(c), bal);
        uint256 got = c.sell(bal, 0, alice);
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(t.balanceOf(alice), 0);
    }
}

interface IERC721Min {
    function ownerOf(uint256 id) external view returns (address);
}
