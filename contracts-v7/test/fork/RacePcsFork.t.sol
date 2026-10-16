// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdCheats} from "forge-std/StdCheats.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {IPriceFeedPcs, IPancakeV3PoolMin} from "../../src/race/RaceBuilderPcs.sol";
import {PcsRaceBase, IMintBurn, IWBNBTest} from "../RacePcsFlow.t.sol";
import {AcrossBridgeForkBase} from "./AcrossBridgeFork.t.sol";

/// Gives / takes a real token with forge's `deal` (real USDC can't be minted).
contract DealMinter is StdCheats {
    IERC20 public immutable token;
    constructor(IERC20 t) { token = t; }
    function mint(address to, uint256 a) external { deal(address(token), to, token.balanceOf(to) + a); }
    function burn(address from, uint256 a) external { deal(address(token), from, token.balanceOf(from) - a); }
}

interface IV3Liquidity {
    function liquidity() external view returns (uint128);
}

interface IV3Slot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
}

interface IFeedInfo {
    function description() external view returns (string memory);
}

/// The whole race flow with chain A on the REAL BNB Chain (run with --fork-url bsc):
/// PancakeSwap Infinity's vault and CL pool manager, PancakeSwap v3 USDC/WBNB, WBNB, USDC
/// (18 decimals) and Chainlink BNB/USD. Chain B (the USDC builder) is deployed in the fork.
contract RacePcsForkTest is PcsRaceBase {
    address constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address constant CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    // PancakeSwap v3 USDC/WBNB pools (different fee tiers); the deeper one is used
    address constant V3_A = 0xf2688Fb5B81049DFB7703aDa5e770543770612C4;
    address constant V3_B = 0x81A9b5F18179cE2bf8f001b8a634Db80771F1824;

    function setUp() public override {
        if (block.chainid != 56) {
            vm.skip(true);
            return;
        }
        // BNB Chain makes a block every ~0.5 s and public nodes drop old state within about a
        // minute: every test forks the newest block again, so it never reads pruned state
        vm.createSelectFork(vm.rpcUrl("bsc"));
        super.setUp();
    }

    function _setupChainA() internal override {
        vault = IVault(VAULT);
        clpm = ICLPoolManager(CL_POOL_MANAGER);
        usdcA = IERC20(USDC);
        minterA = IMintBurn(address(new DealMinter(usdcA)));
        wbnb = IWBNBTest(WBNB);
        feed = IPriceFeedPcs(BNB_USD);
        v3 = IPancakeV3PoolMin(_deeper(V3_A, V3_B));
    }

    function _deeper(address a, address b) internal view returns (address) {
        bool okA = _isDollarPool(a);
        bool okB = _isDollarPool(b);
        require(okA || okB, "no USDC/WBNB v3 pool");
        if (!okB) return a;
        if (!okA) return b;
        return IV3Liquidity(a).liquidity() >= IV3Liquidity(b).liquidity() ? a : b;
    }

    function _isDollarPool(address p) internal view returns (bool) {
        if (p.code.length == 0) return false;
        address t0 = IPancakeV3PoolMin(p).token0();
        address t1 = IPancakeV3PoolMin(p).token1();
        return (t0 == USDC && t1 == WBNB) || (t0 == WBNB && t1 == USDC);
    }

    /// a push on the real pool moves the price ~5% (well past the 2% rule), not to the edge:
    /// crossing every tick would read thousands of slots from a node that prunes old state
    function _pushLimit(bool zeroForOne) internal view override returns (uint160) {
        (uint160 sqrtP,,,,,,) = IV3Slot0(address(v3)).slot0();
        return zeroForOne ? uint160((uint256(sqrtP) * 975) / 1000) : uint160((uint256(sqrtP) * 1025) / 1000);
    }

    /// "BNB cheap in the pool" on the real chain: Chainlink is made to read 6% above the pool
    /// instead of pushing the deep real pool 6% (that crosses thousands of ticks, and the public
    /// node prunes the state before they are all read). Same situation for the builder: the
    /// pool pays less than 98% of the Chainlink value. 0 = nothing to give back.
    function _bnbCheap() internal override returns (uint256) {
        (uint80 r, int256 a, uint256 s, uint256 u, uint80 ar) = feed.latestRoundData();
        vm.mockCall(address(feed), abi.encodeWithSelector(IPriceFeedPcs.latestRoundData.selector), abi.encode(r, (a * 106) / 100, s, u, ar));
        return 0;
    }

    /// "the market comes back": after `_bnbCheap` (0), Chainlink reads the real price again
    function _dollarTrade(bool usdcIn, uint256 amountIn) internal override returns (uint256) {
        if (amountIn == 0) {
            vm.clearMockedCalls();
            return 0;
        }
        return super._dollarTrade(usdcIn, amountIn);
    }

    function _freshFeed() internal override {} // the real feed
    function _maxFeedAge() internal pure override returns (uint256) { return 1 days; }
    function _bigUsdc() internal pure override returns (uint256) { return 30_000_000 * U; }
    function _bigBnb() internal pure override returns (uint256) { return 60_000 ether; }

    // ---- facts about the real contracts the builder relies on

    function test_fork_realAddresses() public {
        assertEq(keccak256(bytes(IFeedInfo(BNB_USD).description())), keccak256("BNB / USD"), "Chainlink BNB/USD");
        assertEq(feed.decimals(), 8);
        assertEq(IERC20Decimals(USDC).decimals(), 18, "BNB Chain USDC has 18 decimals");
        assertTrue(IVault(VAULT).isAppRegistered(CL_POOL_MANAGER), "CL pool manager registered");
        // a sane BNB price, fresh enough
        uint256 p = pb.bnbPrice();
        assertGt(p, 50e8);
        assertLt(p, 5_000e8);
    }

    /// The dollar pool is deep enough for the race's swaps: $5,000 each way at >= 99% of Chainlink.
    function test_fork_dollarPoolDepth() public {
        minterA.mint(bob, 5_000 * U);
        uint256 bnbGot = _dollarTrade(true, 5_000 * U);
        assertGe(pb.bnbToUsdc(bnbGot), (5_000 * U * 99) / 100, "USDC -> BNB");
        uint256 usdcGot = _dollarTrade(false, bnbGot);
        assertGe(usdcGot, (pb.bnbToUsdc(bnbGot) * 99) / 100, "BNB -> USDC");
        emit log_named_address("dollar pool", address(v3));
    }
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// BNB Chain USDC (18 decimals) -> Base USDC (6) through the REAL Across SpokePool
/// (lives here so the BNB Chain CI step, which runs this file, covers it).
contract AcrossBridgeBnbForkTest is AcrossBridgeForkBase {
    function setUp() public {
        if (block.chainid != 56) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.rpcUrl("bsc"));
    }

    function test_bnbToBase() public {
        _depositInto(BNB_SPOKE, BNB_USDC, 8453, BASE_USDC, 6, 1_000e18, 999e6);
    }

    /// First leg of BNB Chain -> Robinhood Chain: to Base, where it is forwarded.
    function test_hopBnbToRobinhoodFirstLeg() public {
        _hopFirstLeg(BNB_SPOKE, BNB_USDC, 8453, BASE_USDC, 6, 1_000e18, 999e6);
    }
}
