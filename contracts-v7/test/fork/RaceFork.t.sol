// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {RaceFlow} from "../RaceFlow.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";

/// The same race flows against the REAL Uniswap v4 deployments of Base and Robinhood Chain
/// (run with --fork-url). Both race "chains" live on the forked chain and share its real
/// PoolManager / PositionManager / Permit2; each has its own test dollar so the bridge can
/// move money between them.
abstract contract RaceForkBase is RaceFlow {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function _real() internal view returns (address pm, address posm) {
        if (block.chainid == 8453) return (0x498581fF718922c3f8e6A244956aF099B2652b2b, 0x7C5f5A4bBd8fD63184577525326123B519429bDc);
        if (block.chainid == 4663) return (0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x58daec3116aae6D93017bAAea7749052E8a04fA7);
        // Arc: the PoolManager has the same address as on Robinhood Chain; its own PositionManager
        // (both checked on the chain by test_fork_arcUniswap)
        if (block.chainid == 5042) return (0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B);
        return (address(0), address(0));
    }

    function _v4(uint32) internal view override returns (IPoolManager, IPositionManager) {
        (address pm, address posm) = _real();
        require(pm != address(0), "fork Base (8453), Robinhood (4663) or Arc (5042)");
        return (IPoolManager(pm), IPositionManager(posm));
    }

    function _permit2() internal pure override returns (address) {
        return PERMIT2;
    }
}

contract RaceForkLowTest is RaceForkBase {
    function _usdcAt(uint32 eid) internal pure override returns (address) { return address(uint160(0x1000 + eid)); }
    function test_fork_launchBothChains() public { _flow_launchBothChains(); }
    function test_fork_launchFee() public { _flow_launchFee(); }
    function test_fork_fullRace() public { _flow_fullRace(); }
    function test_fork_quietRace() public { _flow_quietRace(); }
    function test_fork_router() public { _flow_router(); }
    function test_fork_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_fork_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function test_fork_mergeRaisesPrice() public { _flow_mergeRaisesPrice(); }
    function test_fork_mergeSkipsPumpedCoin() public { _flow_mergeSkipsPumpedCoin(); }
    function test_fork_singleChain() public { _flow_singleChain(); }
    function test_fork_buybackMode() public { _flow_buybackMode(); }
    function testFuzz_fork_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
}

contract RaceForkHighTest is RaceForkBase {
    function _usdcAt(uint32 eid) internal pure override returns (address) { return address(uint160(type(uint160).max - eid)); }
    function test_fork_launchBothChains() public { _flow_launchBothChains(); }
    function test_fork_launchFee() public { _flow_launchFee(); }
    function test_fork_fullRace() public { _flow_fullRace(); }
    function test_fork_quietRace() public { _flow_quietRace(); }
    function test_fork_router() public { _flow_router(); }
    function test_fork_lostIsFinal() public { _flow_lostIsFinal(); }
    function test_fork_deepenAfterDrop() public { _flow_deepenAfterDrop(); }
    function test_fork_mergeRaisesPrice() public { _flow_mergeRaisesPrice(); }
    function test_fork_mergeSkipsPumpedCoin() public { _flow_mergeSkipsPumpedCoin(); }
    function test_fork_singleChain() public { _flow_singleChain(); }
    function test_fork_buybackMode() public { _flow_buybackMode(); }
    function testFuzz_fork_conservation(uint256 seed) public { _flow_fuzzConservation(seed); }
}

interface IPosmPoolManager {
    function poolManager() external view returns (address);
}

/// The chain's REAL dollar on both race "chains" (Base: USDC, Robinhood: USDG, Arc: USDC), real Uniswap.
/// No bridge here (real dollars can't be minted): launch, launch fee, trading, the race
/// verdict, the losing pool's hand-over to the consolidator and the winner going on.
contract RaceForkRealDollarTest is RaceForkBase {
    function _usdcAt(uint32) internal view override returns (address) {
        if (block.chainid == 8453) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
        if (block.chainid == 4663) return 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // USDG
        if (block.chainid == 5042) return 0x3600000000000000000000000000000000000000; // USDC (6-decimal view of Arc's own money)
        revert("fork Base, Robinhood or Arc");
    }

    function _deployDollar() internal pure override returns (bool) {
        return false;
    }

    function _fund(Net memory c, address who, uint256 amount) internal override {
        if (block.chainid == 5042) {
            // on Arc USDC is the chain's own money (18 decimals natively, 6 through the ERC-20)
            vm.deal(who, who.balance + amount * 1e12);
            return;
        }
        deal(address(c.usdc), who, IERC20(address(c.usdc)).balanceOf(who) + amount);
    }

    /// Arc only: the Uniswap v4 PositionManager really belongs to the PoolManager we use, and
    /// the ERC-20 USDC is the same money as the native balance.
    function test_fork_arcUniswap() public {
        if (block.chainid != 5042) return;
        (address pm, address posm) = _real();
        assertGt(pm.code.length, 0, "PoolManager deployed");
        assertGt(posm.code.length, 0, "PositionManager deployed");
        assertEq(IPosmPoolManager(posm).poolManager(), pm, "PositionManager uses this PoolManager");
        address x = address(0xA4C0);
        vm.deal(x, 3 ether);
        assertEq(IERC20(0x3600000000000000000000000000000000000000).balanceOf(x), 3 * 1e6, "3 USDC");
    }

    function test_fork_realDollar_decimals() public view {
        assertEq(IERC20Metadata(address(a.usdc)).decimals(), 6);
    }

    function test_fork_realDollar_launchAndRace() public {
        // Arc: USDC is the chain's own money, moved by Arc's own built-in code that the test
        // tool may not have. A plain 1 USDC transfer between two wallets shows whether it does.
        if (block.chainid == 5042) {
            vm.deal(alice, 10 ether);
            vm.prank(alice);
            (bool ok,) = address(a.usdc).call{gas: 1_000_000}(abi.encodeCall(IERC20.transfer, (bob, 1e6)));
            console.log("plain Arc USDC transfer works in the test tool:", ok);
            if (!ok) {
                console.log("=> the test tool can't run Arc's USDC; this flow is checked on Arc testnet instead");
                vm.skip(true);
                return;
            }
        }
        // each stage is logged, so a failure on a new chain shows where it stopped
        console.log("stage: launch A");
        (address ca,) = _launch(a, _eids2(), 5 * D, 0);
        console.log("stage: launch B");
        (address cb,) = _launch(b, _eids2(), 5 * D, 0);
        console.log("stage: buy A");
        _buy(a, ca, alice, 200 * D);
        console.log("stage: buy B");
        _buy(b, cb, bob, 50 * D);
        vm.warp(block.timestamp + 301);
        console.log("stage: buy A after the race");
        uint256 got = _buy(a, ca, alice, 25 * D);
        assertGt(got, 0);
        bytes32 id = _coinId();
        console.log("stage: freeze A");
        vm.prank(keeper);
        a.hub.freeze(id, "");
        console.log("stage: freeze B");
        vm.prank(keeper);
        b.hub.freeze(id, "");
        console.log("stage: report B -> A");
        a.ep.deliver(b.ep.packetAt(b.ep.packetCount() - 1));
        console.log("stage: finalize on A");
        a.hub.finalize(id, 0, "");
        console.log("stage: verdict A -> B (B loses, hands over)");
        b.ep.deliver(a.ep.packetAt(a.ep.packetCount() - 1));
        (uint256 usdB,) = b.builder.poolAmounts(cb);
        assertEq(usdB, 0, "losing pool emptied");
        assertGt(b.cons.pendingPool(_coinId()), 0, "money waiting to cross");
        console.log("stage: sell on A");
        assertGt(_sell(a, ca, alice, IERC20(ca).balanceOf(alice) / 2), 0);
        console.log("stage: done");
    }
}
