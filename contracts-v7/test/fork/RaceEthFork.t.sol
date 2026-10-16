// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPriceFeed} from "../../src/race/RaceBuilderEth.sol";
import {EthRaceBase} from "../RaceEthFlow.t.sol";
import {IMintBurn} from "../RacePcsFlow.t.sol";
import {DealMinter} from "./RacePcsFork.t.sol";

interface IFeedDescription {
    function description() external view returns (string memory);
}

/// The whole race flow with chain A on the REAL Base or Robinhood Chain (run with --fork-url):
/// Uniswap v4 (PoolManager, PositionManager, Permit2), the chain's deepest native ETH / dollar
/// v4 pool, the real dollar (Base: USDC, Robinhood: USDG) and Chainlink ETH/USD.
contract RaceEthForkTest is EthRaceBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function _chain() internal view returns (address pm, address posm, address dollar, address ethUsd) {
        if (block.chainid == 8453) {
            return (
                0x498581fF718922c3f8e6A244956aF099B2652b2b,
                0x7C5f5A4bBd8fD63184577525326123B519429bDc,
                0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, // USDC
                0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 // Chainlink ETH / USD
            );
        }
        if (block.chainid == 4663) {
            return (
                0x8366a39CC670B4001A1121B8F6A443A643e40951,
                0x58daec3116aae6D93017bAAea7749052E8a04fA7,
                0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, // USDG
                0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 // Chainlink (W)ETH / USD, checked below
            );
        }
        return (address(0), address(0), address(0), address(0));
    }

    function setUp() public override {
        if (block.chainid != 8453 && block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        super.setUp();
    }

    function _setupChainA() internal override {
        (address pm, address posm, address dollar, address ethUsd) = _chain();
        permit2 = IAllowanceTransfer(PERMIT2);
        pmA = IPoolManager(pm);
        posmA = IPositionManager(posm);
        usdcA = IERC20(dollar);
        minterA = IMintBurn(address(new DealMinter(usdcA)));
        feed = IPriceFeed(ethUsd);
        dollarKey = _deepestDollarPool(dollar);
    }

    /// The native ETH / dollar v4 pool (no hook) with the most liquidity at the current price.
    function _deepestDollarPool(address dollar) internal view returns (PoolKey memory best) {
        uint24[5] memory fees = [uint24(100), 500, 3000, 10000, 50];
        int24[5] memory spacings = [int24(1), 10, 60, 200, 1];
        uint128 bestLiq;
        for (uint256 i; i < fees.length; ++i) {
            PoolKey memory k = PoolKey(Currency.wrap(address(0)), Currency.wrap(dollar), fees[i], spacings[i], IHooks(address(0)));
            (uint160 sqrtP,,,) = pmA.getSlot0(k.toId());
            if (sqrtP == 0) continue;
            uint128 liq = pmA.getLiquidity(k.toId());
            if (liq > bestLiq) {
                bestLiq = liq;
                best = k;
            }
        }
        require(bestLiq > 0, "no native ETH / dollar v4 pool on this chain");
    }

    function _freshFeed() internal override {} // the real feed
    function _maxFeedAge() internal pure override returns (uint256) { return 1 days; }
    function _bigUsdc() internal pure override returns (uint256) { return 50_000_000 * D; }
    function _bigEth() internal pure override returns (uint256) { return 20_000 ether; }

    // ---- facts about the real contracts the builder relies on

    function test_fork_realAddresses() public {
        string memory d = IFeedDescription(address(feed)).description();
        bytes32 h = keccak256(bytes(d));
        assertTrue(h == keccak256("ETH / USD") || h == keccak256("WETH / USD"), d);
        assertEq(feed.decimals(), 8);
        uint256 p = eb.ethPrice();
        assertGt(p, 500e8);
        assertLt(p, 20_000e8);
        emit log_named_uint("dollar pool fee", dollarKey.fee);
        emit log_named_int("dollar pool tick spacing", dollarKey.tickSpacing);
        emit log_named_uint("dollar pool liquidity", pmA.getLiquidity(dollarKey.toId()));
    }

    /// The dollar pool is deep enough for the race's swaps: $5,000 each way at >= 99% of Chainlink.
    function test_fork_dollarPoolDepth() public {
        minterA.mint(bob, 5_000 * D);
        vm.prank(bob);
        uint256 ethGot = desk.swap(dollarKey, false, 5_000 * D);
        assertGe(_ethUsdc(ethGot), (5_000 * D * 99) / 100, "USDC -> ETH");
        vm.prank(bob);
        uint256 usdcGot = desk.swap{value: ethGot}(dollarKey, true, ethGot);
        assertGe(usdcGot, (_ethUsdc(ethGot) * 99) / 100, "ETH -> USDC");
    }
}
