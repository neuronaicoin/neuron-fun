// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {IOFT} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";

import {OmniHub} from "../../src/omni/OmniHub.sol";
import {OftUsdBridge} from "../../src/omni/OftUsdBridge.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";
import {ConsolidatorV6, IHubLocal, IUsdcBridge} from "../../src/omni/ConsolidatorV6.sol";
import {OmniCoinDeployer} from "../../src/omni/OmniDeployers.sol";
import {UsdPoolRouter, IUsdGraduatedPools} from "../../src/usd/UsdPoolRouter.sol";
import {RaceBuilder} from "../../src/race/RaceBuilder.sol";
import {RaceBuilderEth, IPriceFeed} from "../../src/race/RaceBuilderEth.sol";
import {RaceBuilderPcs, IPriceFeedPcs, IWrappedNative, IPancakeV3PoolMin} from "../../src/race/RaceBuilderPcs.sol";
import {RaceLaunchHook} from "../../src/race/RaceLaunchHook.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";
import {RaceTradeEth, IRaceBuilderEthPools} from "../../src/race/RaceTradeEth.sol";
import {RaceTradePcs, IRaceBuilderPcsPools} from "../../src/race/RaceTradePcs.sol";
import {RaceCrossEth, RaceCrossPcs, RaceCrossUsdc, IRaceRouter} from "../../src/race/RaceCross.sol";
import {AutoOrders} from "../../src/auto/AutoOrders.sol";
import {SasaFeeVault} from "../../src/fees/SasaFeeVault.sol";
import {TestUsdV7, TestFeed, TestDollarPool, ITestFeedPrice} from "../../src/race/testnet/TestnetSupport.sol";

interface IFeedDescription {
    function description() external view returns (string memory);
}

/**
 * @notice sasa v7 (five-minute race) on ONE chain. Run it on every chain first, then
 * WireRace on every chain. Writes the addresses to deployments/race/<chainid>.json.
 *
 * BUILDER_KIND picks the coin pair of this chain:
 *   eth  - coin/ETH on Uniswap v4 (Base, Robinhood Chain): RaceBuilderEth + RaceTradeEth
 *   pcs  - coin/BNB on PancakeSwap Infinity (BNB Chain):   RaceBuilderPcs + RaceTradePcs
 *   usdc - coin/USDC on Uniswap v4 (Arc):                  RaceBuilder + UsdPoolRouter
 *
 * Two keys:
 *  - PRIVATE_KEY: the deployer (hub, bridge, builder, consolidator, router, wiring).
 *  - RACE_FACTORY_KEY: a NEW wallet used for exactly two transactions per chain: nonce 0
 *    deploys the coin deployer, nonce 1 the factory. Same key + same nonces = the same
 *    factory address on every chain = every coin at the same address on every chain.
 *
 * Mainnet (TESTNET=false): USD_TOKEN is the chain's dollar, PRICE_FEED the Chainlink
 * ETH/USD or BNB/USD feed, the dollar pool is the chain's real one, ACROSS_SPOKE is set.
 * Testnet (TESTNET=true): a fresh test dollar (TestUsdV7, an OFT) unless USD_TOKEN is given;
 * TestFeed when PRICE_FEED is empty; the dollar pool is created and seeded here.
 */
contract DeployRace is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    enum Kind {
        Usdc,
        Eth,
        Pcs
    }

    struct Cfg {
        Kind kind;
        bool testnet;
        address deployer;
        address feeVault; // sasa's fee vault: the race contracts' treasury (splits to keeper / rewards / treasury)
        address usd;
        bool usdIsTest;
        address feed;
        bool feedIsTest;
        uint256 maxFeedAge;
        // eth / usdc
        address poolManager;
        address positionManager;
        uint24 dollarFee;
        int24 dollarSpacing;
        // pcs
        address vault;
        address clPoolManager;
        address wnative;
        address dollarPool;
        bool dollarPoolIsTest;
    }

    struct Out {
        address hub;
        address bridge;
        address builder;
        address hook;
        address consolidator;
        address router;
        address factory;
        address coinDeployer;
        address cross; // trades here with dollars kept on Base (not on Base itself)
        address autoOrders; // take profit / stop loss / buy the dip (mainnet)
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        uint256 fkey = vm.envUint("RACE_FACTORY_KEY");
        Cfg memory c;
        c.deployer = vm.addr(key);
        address fdeployer = vm.addr(fkey);
        c.kind = _kind(vm.envString("BUILDER_KIND"));
        c.testnet = vm.envOr("TESTNET", false);
        address endpoint = vm.envAddress("LZ_ENDPOINT");
        uint32 localEid = uint32(vm.envUint("LOCAL_EID"));
        uint32 coordEid = uint32(vm.envUint("COORD_EID"));
        address spoke = vm.envOr("ACROSS_SPOKE", address(0));
        bool across = spoke != address(0);
        address treasury = vm.envOr("TREASURY", c.deployer);
        address keeper = vm.envOr("KEEPER", c.deployer);
        address owner = vm.envOr("ADMIN", c.deployer);
        uint8 minDvns = uint8(vm.envOr("MIN_DVNS", uint256(1)));
        uint256 startMc = vm.envOr("START_MC", uint256(3_000e6));
        uint256 minFirstBuy = vm.envOr("MIN_FIRST_BUY", uint256(5e6));
        c.usd = vm.envOr("USD_TOKEN", address(0));
        c.feed = vm.envOr("PRICE_FEED", address(0));
        c.maxFeedAge = vm.envOr("MAX_FEED_AGE", uint256(2 hours));
        // Base's ETH/USD and BNB Chain's BNB/USD feeds update far more often than hourly: an
        // older price there means something is wrong, so it is never accepted for a race result
        if ((block.chainid == 8453 || block.chainid == 56) && c.maxFeedAge > 1 hours) c.maxFeedAge = 1 hours;

        require(ILayerZeroEndpointV2(endpoint).eid() == localEid, "LZ endpoint is not the one for LOCAL_EID");
        require(fdeployer != c.deployer, "RACE_FACTORY_KEY must be a separate wallet");
        require(vm.getNonce(fdeployer) == 0, "RACE_FACTORY_KEY wallet was used before: needs nonce 0 on every chain");
        if (!c.testnet) {
            require(c.usd != address(0) && c.usd.code.length > 0, "USD_TOKEN: the chain's dollar is required on mainnet");
            require(across, "ACROSS_SPOKE is required on mainnet");
            require(spoke.code.length > 0, "ACROSS_SPOKE has no code on this chain");
        } else {
            require(!across, "testnets use the OFT test dollar bridge, not Across");
        }
        if (c.kind == Kind.Pcs) {
            c.vault = vm.envAddress("VAULT");
            c.clPoolManager = vm.envAddress("CL_POOL_MANAGER");
            c.wnative = vm.envAddress("WNATIVE");
            c.dollarPool = vm.envOr("DOLLAR_POOL", address(0));
            require(c.vault.code.length > 0 && c.clPoolManager.code.length > 0 && c.wnative.code.length > 0, "PancakeSwap Infinity / WBNB missing here");
            require(IVault(c.vault).isAppRegistered(c.clPoolManager), "CL pool manager is not registered in this vault");
        } else {
            c.poolManager = vm.envAddress("POOL_MANAGER");
            c.positionManager = vm.envAddress("POSITION_MANAGER");
            require(PERMIT2.code.length > 0 && c.poolManager.code.length > 0 && c.positionManager.code.length > 0, "Uniswap v4 missing here");
            if (c.kind == Kind.Eth) {
                c.dollarFee = uint24(vm.envUint("DOLLAR_FEE"));
                c.dollarSpacing = int24(int256(vm.envUint("DOLLAR_SPACING")));
            }
        }
        if (c.kind != Kind.Usdc && !c.testnet) {
            require(c.feed != address(0) && c.feed.code.length > 0, "PRICE_FEED (Chainlink) is required on mainnet");
        }

        // ---- 1. testnet support (test dollar, test feed, test dollar pool), deployer key
        vm.startBroadcast(key);
        if (c.usd == address(0)) {
            require(c.testnet, "no dollar");
            c.usd = address(new TestUsdV7(endpoint, c.deployer));
            c.usdIsTest = true;
            console2.log("Test dollar (OFT):", c.usd);
        }
        if (c.kind != Kind.Usdc && c.feed == address(0)) {
            require(c.testnet, "no feed");
            int256 price = int256(vm.envOr("FEED_PRICE_USD", uint256(c.kind == Kind.Eth ? 2_500 : 600))) * 1e8;
            c.feed = address(new TestFeed(c.kind == Kind.Eth ? "ETH / USD" : "BNB / USD", price, c.deployer));
            c.feedIsTest = true;
            console2.log("Test feed:", c.feed);
        }
        if (c.kind != Kind.Usdc) _checkFeed(c);
        if (c.kind == Kind.Pcs) _dollarPoolPcs(c);
        if (c.kind == Kind.Eth) _dollarPoolEth(c);
        vm.stopBroadcast();
        treasury = _feeVault(key, keeper, treasury, c);

        // ---- 2. addresses: the factory needs the hub and the builder before they exist
        address coinDeployerAt = vm.computeCreateAddress(fdeployer, 0);
        address factoryAt = vm.computeCreateAddress(fdeployer, 1);
        require(factoryAt.code.length == 0, "factory already deployed here");
        uint64 n = vm.getNonce(c.deployer);
        address hubAt = vm.computeCreateAddress(c.deployer, n);
        address bridgeAt = vm.computeCreateAddress(c.deployer, n + 1);
        address builderAt = vm.computeCreateAddress(c.deployer, n + 2);
        address consolidatorAt = vm.computeCreateAddress(c.deployer, n + 3);
        address routerAt = vm.computeCreateAddress(c.deployer, n + 4);
        bytes32 salt = c.kind == Kind.Pcs ? bytes32(0) : _mineHookSalt(c.poolManager, builderAt);
        uint256 fund = vm.envOr("FUND_DEPLOYER", uint256(0));

        // ---- 3. the factory (its own fresh wallet, nonces 0 and 1)
        Out memory o;
        vm.startBroadcast(fkey);
        OmniCoinDeployer coinDeployer = new OmniCoinDeployer(factoryAt);
        RaceFactory factory = new RaceFactory(
            c.deployer, ILayerZeroEndpointV2(endpoint), localEid, IERC20(c.usd), hubAt, builderAt, treasury, minDvns, coinDeployer,
            startMc, minFirstBuy, 10
        );
        if (fund > 0) {
            (bool ok,) = c.deployer.call{value: fund}("");
            require(ok, "top-up failed");
        }
        vm.stopBroadcast();
        require(address(coinDeployer) == coinDeployerAt && address(factory) == factoryAt, "factory address moved");
        o.factory = address(factory);
        o.coinDeployer = address(coinDeployer);

        // ---- 4. hub, bridge, builder, consolidator, router (deployer key, in this order)
        vm.startBroadcast(key);
        o.hub = address(new OmniHub(endpoint, c.deployer, coordEid, localEid));
        o.bridge = across
            ? address(new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(c.usd), c.deployer))
            : address(new OftUsdBridge(IOFT(c.usd), endpoint, c.deployer));
        if (c.kind == Kind.Eth) {
            RaceBuilderEth b = new RaceBuilderEth(
                IPoolManager(c.poolManager), IPositionManager(c.positionManager), IAllowanceTransfer(PERMIT2), IERC20(c.usd), treasury, salt,
                _dollarKey(c), IPriceFeed(c.feed), c.maxFeedAge
            );
            o.builder = address(b);
            o.hook = address(b.hook());
            o.consolidator = address(new ConsolidatorV6(IERC20(c.usd), IHubLocal(o.hub), IUsdcBridge(o.bridge)));
            o.router = address(new RaceTradeEth(IRaceBuilderEthPools(o.builder)));
            b.bind(o.factory, o.consolidator, o.bridge);
            require(b.factory() == o.factory && b.consolidator() == o.consolidator && b.bridge() == o.bridge, "builder wiring");
        } else if (c.kind == Kind.Pcs) {
            RaceBuilderPcs b = new RaceBuilderPcs(
                IVault(c.vault), ICLPoolManager(c.clPoolManager), IERC20(c.usd), IWrappedNative(c.wnative), IPancakeV3PoolMin(c.dollarPool),
                treasury, IPriceFeedPcs(c.feed), c.maxFeedAge
            );
            o.builder = address(b);
            o.hook = address(b.hook());
            o.consolidator = address(new ConsolidatorV6(IERC20(c.usd), IHubLocal(o.hub), IUsdcBridge(o.bridge)));
            o.router = address(new RaceTradePcs(IRaceBuilderPcsPools(o.builder)));
            b.bind(o.factory, o.consolidator, o.bridge);
            require(b.factory() == o.factory && b.consolidator() == o.consolidator && b.bridge() == o.bridge, "builder wiring");
        } else {
            RaceBuilder b = new RaceBuilder(
                IPoolManager(c.poolManager), IPositionManager(c.positionManager), IAllowanceTransfer(PERMIT2), IERC20(c.usd), treasury, salt
            );
            o.builder = address(b);
            o.hook = address(b.hook());
            o.consolidator = address(new ConsolidatorV6(IERC20(c.usd), IHubLocal(o.hub), IUsdcBridge(o.bridge)));
            o.router = address(new UsdPoolRouter(IPoolManager(c.poolManager), IUsdGraduatedPools(o.builder)));
            b.bind(o.factory, o.consolidator, o.bridge);
            require(b.factory() == o.factory && b.consolidator() == o.consolidator && b.bridge() == o.bridge, "builder wiring");
        }
        OmniHub(payable(o.hub)).setKeeper(keeper);
        OmniHub(payable(o.hub)).setFactory(o.factory);
        // race fee per chain in this chain's dollar units (mainnet: $0.50 -> 500000 for 6 decimals, 5e17 on BNB Chain)
        uint256 raceFee = vm.envOr("RACE_FEE", uint256(0));
        if (raceFee > 0) factory.setRaceFee(raceFee);
        // the race fee goes to the keeper: it pays the race's network fees (gas, LayerZero)
        factory.setRaceFeeTo(keeper);
        vm.stopBroadcast();

        require(o.hub == hubAt && o.bridge == bridgeAt && o.builder == builderAt, "address moved (hub/bridge/builder)");
        require(o.consolidator == consolidatorAt && o.router == routerAt, "address moved (consolidator/router)");
        require(factory.hub() == o.hub && factory.builder() == o.builder && address(factory.usdc()) == c.usd, "factory wiring");
        require(factory.raceFeeTo() == keeper, "race fee to keeper");
        o.cross = _cross(key, c, o, spoke);
        vm.startBroadcast(key);
        // RaceCross launches for sasa accounts whose dollars are on Base (with their signature)
        if (o.cross != address(0)) factory.setLauncher(o.cross);
        if (owner != c.deployer) factory.transferOwnership(owner);
        vm.stopBroadcast();
        require(factory.launcher() == o.cross, "launcher");
        o.autoOrders = _auto(key, c, o, spoke, keeper, owner);

        _write(c, o, localEid, coordEid, across, startMc, minFirstBuy);
        console2.log("--- sasa v7 (race) ---");
        console2.log("Chain id / eid: ", block.chainid, localEid);
        console2.log("Builder kind:   ", _kindName(c.kind));
        console2.log("Dollar:         ", c.usd, c.usdIsTest ? "(test)" : "");
        console2.log("OmniHub:        ", o.hub);
        console2.log("Dollar bridge:  ", o.bridge);
        console2.log("Builder / hook: ", o.builder, o.hook);
        console2.log("Consolidator:   ", o.consolidator);
        console2.log("Trade router:   ", o.router);
        if (o.cross != address(0)) console2.log("Cross trades:   ", o.cross);
        console2.log("RaceFactory:    ", o.factory, "(same on every chain)");
    }

    /**
     * @dev AutoOrders (mainnet, where Across runs): the keeper executes signed take profit / stop
     * loss / buy the dip orders and gets the 0.1% fee for its network fees. Routers it may use:
     * this chain's race router, and Relay's (RELAY_ROUTERS, whitelisted only where they exist).
     * BUY_CROSS routes to the other chains' RaceCross are set by WireRace on the home chain.
     */
    function _auto(uint256 key, Cfg memory c, Out memory o, address spoke, address keeper, address owner) internal returns (address a) {
        if (spoke == address(0) && !vm.envOr("AUTO_ORDERS", false)) return address(0);
        uint256 home = vm.envOr("CROSS_HOME_CHAIN_ID", block.chainid);
        address homeUsdc = home == block.chainid ? c.usd : vm.envAddress("CROSS_HOME_USDC");
        uint8 homeDec = home == block.chainid ? IERC20Metadata(c.usd).decimals() : uint8(vm.envOr("CROSS_HOME_DECIMALS", uint256(6)));
        address[] memory relay = vm.envOr(
            "RELAY_ROUTERS", ",", _defaultRelay()
        );
        vm.startBroadcast(key);
        AutoOrders ao = new AutoOrders(c.deployer, IERC20(c.usd), IAcrossSpokePool(spoke), home, IERC20(homeUsdc), homeDec, keeper);
        ao.setKeeper(keeper, true);
        ao.setRouter(o.router, true, true);
        for (uint256 i; i < relay.length; ++i) {
            if (relay[i].code.length > 0) ao.setRouter(relay[i], true, true);
            else console2.log("Relay contract not on this chain, skipped:", relay[i]);
        }
        if (owner != c.deployer) ao.transferOwnership(owner);
        vm.stopBroadcast();
        a = address(ao);
        console2.log("Auto orders:    ", a);
    }

    function _defaultRelay() internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = 0xBBbfD134E9b44BfB5123898BA36b01dE7ab93d98; // Relay ApprovalProxy
        r[1] = 0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222; // Relay Router
    }

    /**
     * @dev RaceCross: buys here paid from dollars kept on the home chain (Base), and sells back
     * home, through Across. Only on mainnet chains other than the home chain (CROSS_HOME_CHAIN_ID,
     * CROSS_HOME_USDC; CROSS_GAS_FLOOR = the native balance under which a buy tops up gas).
     */
    function _cross(uint256 key, Cfg memory c, Out memory o, address spoke) internal returns (address x) {
        uint256 home = vm.envOr("CROSS_HOME_CHAIN_ID", uint256(0));
        if (home == 0 || home == block.chainid || spoke == address(0)) return address(0);
        IERC20 homeUsdc = IERC20(vm.envAddress("CROSS_HOME_USDC"));
        uint8 homeDec = uint8(vm.envOr("CROSS_HOME_DECIMALS", uint256(6)));
        uint256 floor = vm.envUint("CROSS_GAS_FLOOR");
        vm.startBroadcast(key);
        if (c.kind == Kind.Eth) {
            x = address(new RaceCrossEth(IAcrossSpokePool(spoke), IRaceBuilderEthPools(o.builder), IRaceRouter(o.router), RaceFactory(o.factory), home, homeUsdc, homeDec, floor));
        } else if (c.kind == Kind.Pcs) {
            x = address(new RaceCrossPcs(IAcrossSpokePool(spoke), IERC20(c.usd), IWrappedNative(c.wnative), IPancakeV3PoolMin(c.dollarPool),
                IRaceRouter(o.router), RaceFactory(o.factory), home, homeUsdc, homeDec, floor));
        } else {
            x = address(new RaceCrossUsdc(IAcrossSpokePool(spoke), IERC20(c.usd), IRaceRouter(o.router), RaceFactory(o.factory), home, homeUsdc, homeDec, floor));
        }
        vm.stopBroadcast();
    }

    // ------------------------------------------------------------------ checks and testnet pools

    function _checkFeed(Cfg memory c) internal view {
        string memory d = IFeedDescription(c.feed).description();
        bytes32 h = keccak256(bytes(d));
        bool ok = c.kind == Kind.Eth ? (h == keccak256("ETH / USD") || h == keccak256("WETH / USD")) : h == keccak256("BNB / USD");
        require(ok, string.concat("PRICE_FEED is not the right feed: ", d));
        require(ITestFeedPrice(c.feed).decimals() == 8, "feed decimals");
        (, int256 a,, uint256 t,) = ITestFeedPrice(c.feed).latestRoundData();
        require(a > 0 && t <= block.timestamp && block.timestamp - t <= c.maxFeedAge, "feed price is stale: raise MAX_FEED_AGE or check the feed");
        console2.log("feed price (8 dec):", uint256(a));
    }

    function _dollarKey(Cfg memory c) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(c.usd), c.dollarFee, c.dollarSpacing, IHooks(address(0)));
    }

    /// @dev eth kind: the native ETH / dollar Uniswap v4 pool. Mainnet: must exist with liquidity.
    /// Testnet: created at the feed price and seeded with SEED_WEI of test ETH (plus the matching
    /// test dollars, minted) in a narrow range around the price, so small trades move it little.
    function _dollarPoolEth(Cfg memory c) internal {
        IPoolManager pm = IPoolManager(c.poolManager);
        PoolKey memory k = _dollarKey(c);
        (uint160 sqrtP,,,) = pm.getSlot0(k.toId());
        if (!c.testnet) {
            require(sqrtP != 0 && pm.getLiquidity(k.toId()) > 0, "the ETH / dollar v4 pool (DOLLAR_FEE, DOLLAR_SPACING) has no liquidity here");
            console2.log("dollar pool liquidity:", pm.getLiquidity(k.toId()));
            return;
        }
        uint256 seedWei = vm.envOr("SEED_WEI", uint256(0.05 ether));
        (, int256 a,,,) = ITestFeedPrice(c.feed).latestRoundData();
        uint256 usdDec = IERC20Metadata(c.usd).decimals();
        uint256 usdPerEth = (uint256(a) * 10 ** usdDec) / 1e8; // dollars per 1 ETH, in usd units
        if (sqrtP == 0) {
            sqrtP = uint160(Math.sqrt(Math.mulDiv(usdPerEth, 1 << 192, 1 ether)));
            pm.initialize(k, sqrtP);
            console2.log("dollar pool created");
        }
        if (seedWei == 0 || pm.getLiquidity(k.toId()) > 0) {
            console2.log("dollar pool liquidity:", pm.getLiquidity(k.toId()));
            return;
        }
        uint256 seedUsd = Math.mulDiv(seedWei, usdPerEth, 1 ether);
        if (c.usdIsTest) TestUsdV7(c.usd).mint(c.deployer, seedUsd);
        require(IERC20(c.usd).balanceOf(c.deployer) >= seedUsd, "deployer needs test dollars to seed the pool");
        require(c.deployer.balance > seedWei, "deployer needs test ETH to seed the pool (SEED_WEI)");
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lower = _floor(tick - 200, c.dollarSpacing);
        int24 upper = _floor(tick + 200, c.dollarSpacing) + c.dollarSpacing;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), seedWei, seedUsd
        );
        IERC20(c.usd).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(c.usd, c.positionManager, type(uint160).max, uint48(block.timestamp + 1 hours));
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(k, lower, upper, uint256(liq), seedWei, seedUsd, c.deployer, bytes(""));
        params[1] = abi.encode(k.currency0, k.currency1);
        params[2] = abi.encode(k.currency0, c.deployer);
        IPositionManager(c.positionManager).modifyLiquidities{value: seedWei}(abi.encode(actions, params), block.timestamp + 1 hours);
        require(pm.getLiquidity(k.toId()) > 0, "seeding the dollar pool failed");
        console2.log("dollar pool seeded, liquidity:", pm.getLiquidity(k.toId()));
    }

    /// @dev pcs kind: the PancakeSwap v3 USDC/WBNB pool. Mainnet: DOLLAR_POOL must be that pool.
    /// Testnet: a TestDollarPool (fills at the feed price) seeded with SEED_WEI of BNB and test dollars.
    function _dollarPoolPcs(Cfg memory c) internal {
        if (c.dollarPool != address(0)) {
            address t0 = IPancakeV3PoolMin(c.dollarPool).token0();
            address t1 = IPancakeV3PoolMin(c.dollarPool).token1();
            require((t0 == c.usd && t1 == c.wnative) || (t0 == c.wnative && t1 == c.usd), "DOLLAR_POOL is not the USDC/WBNB pool");
            return;
        }
        require(c.testnet, "DOLLAR_POOL (PancakeSwap v3 USDC/WBNB) is required on mainnet");
        uint8 usdDec = IERC20Metadata(c.usd).decimals();
        TestDollarPool p = new TestDollarPool(IERC20(c.usd), IERC20(c.wnative), usdDec, ITestFeedPrice(c.feed), c.deployer);
        c.dollarPool = address(p);
        c.dollarPoolIsTest = true;
        uint256 seedWei = vm.envOr("SEED_WEI", uint256(0.05 ether));
        if (seedWei > 0) {
            require(c.deployer.balance > seedWei, "deployer needs test BNB to seed the pool (SEED_WEI)");
            (bool ok,) = address(p).call{value: seedWei}("");
            require(ok, "seeding BNB failed");
        }
        uint256 seedUsd = vm.envOr("SEED_USD", uint256(1_000_000)) * 10 ** usdDec;
        if (c.usdIsTest) TestUsdV7(c.usd).mint(address(p), seedUsd);
        else IERC20(c.usd).transfer(address(p), Math.min(seedUsd, IERC20(c.usd).balanceOf(c.deployer)));
        console2.log("Test dollar pool:", c.dollarPool);
    }

    // ------------------------------------------------------------------ helpers

    function _write(Cfg memory c, Out memory o, uint32 localEid, uint32 coordEid, bool across, uint256 startMc, uint256 minFirstBuy) internal {
        string memory j = "race";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "eid", localEid);
        vm.serializeUint(j, "coordEid", coordEid);
        vm.serializeString(j, "builderKind", _kindName(c.kind));
        vm.serializeBool(j, "testnet", c.testnet);
        vm.serializeString(j, "bridgeKind", across ? "across" : "oft");
        vm.serializeAddress(j, "usd", c.usd);
        vm.serializeUint(j, "usdDecimals", IERC20Metadata(c.usd).decimals());
        vm.serializeBool(j, "usdIsTest", c.usdIsTest);
        vm.serializeAddress(j, "feed", c.feed);
        vm.serializeBool(j, "feedIsTest", c.feedIsTest);
        vm.serializeUint(j, "maxFeedAge", c.maxFeedAge);
        vm.serializeAddress(j, "poolManager", c.poolManager);
        vm.serializeAddress(j, "positionManager", c.positionManager);
        vm.serializeUint(j, "dollarFee", c.dollarFee);
        vm.serializeInt(j, "dollarSpacing", c.dollarSpacing);
        vm.serializeAddress(j, "vault", c.vault);
        vm.serializeAddress(j, "clPoolManager", c.clPoolManager);
        vm.serializeAddress(j, "wnative", c.wnative);
        vm.serializeAddress(j, "dollarPool", c.dollarPool);
        vm.serializeBool(j, "dollarPoolIsTest", c.dollarPoolIsTest);
        vm.serializeAddress(j, "hub", o.hub);
        vm.serializeAddress(j, "bridge", o.bridge);
        vm.serializeAddress(j, "builder", o.builder);
        vm.serializeAddress(j, "hook", o.hook);
        vm.serializeAddress(j, "consolidator", o.consolidator);
        vm.serializeAddress(j, "router", o.router);
        vm.serializeAddress(j, "cross", o.cross);
        vm.serializeAddress(j, "autoOrders", o.autoOrders);
        vm.serializeAddress(j, "feeVault", c.feeVault);
        vm.serializeAddress(j, "coinDeployer", o.coinDeployer);
        vm.serializeUint(j, "startMarketCap", startMc);
        vm.serializeUint(j, "minFirstBuy", minFirstBuy);
        vm.serializeUint(j, "raceFee", RaceFactory(o.factory).raceFee());
        vm.serializeUint(j, "startBlock", block.number);
        string memory out = vm.serializeAddress(j, "factory", o.factory);
        vm.writeJson(out, string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/race/")), vm.toString(block.chainid), ".json"));
    }

    /// sasa's rewards wallet on mainnet (pays invite rewards); REWARDS overrides it.
    address internal constant MAINNET_REWARDS = 0x4670db0a98Ac28D4093969E3Dfbf16045E321073;

    /**
     * @dev The fee vault: every fee the race contracts pay sasa goes here, and anyone can split it
     * (10% keeper, 10% rewards, 80% treasury). Deployed on mainnet, or wherever REWARDS is set;
     * it then stands in for the treasury everywhere. Owned by the treasury.
     */
    function _feeVault(uint256 key, address keeper, address treasury, Cfg memory c) internal returns (address) {
        string memory raw = vm.envOr("REWARDS", string(""));
        address rewards = bytes(raw).length > 0 ? vm.parseAddress(raw) : c.testnet ? address(0) : MAINNET_REWARDS;
        if (rewards == address(0)) return treasury;
        require(keeper != treasury && rewards != treasury, "fee vault: keeper / rewards must not be the treasury");
        vm.startBroadcast(key);
        SasaFeeVault v = new SasaFeeVault(keeper, rewards, treasury, IERC20(c.usd));
        vm.stopBroadcast();
        require(v.treasury() == treasury && v.keeper() == keeper && v.rewards() == rewards && v.owner() == treasury, "fee vault wiring");
        c.feeVault = address(v);
        console2.log("Fee vault:      ", address(v));
        return address(v);
    }

    function _kind(string memory s) internal pure returns (Kind) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("eth")) return Kind.Eth;
        if (h == keccak256("pcs")) return Kind.Pcs;
        if (h == keccak256("usdc")) return Kind.Usdc;
        revert("BUILDER_KIND must be eth, pcs or usdc");
    }

    function _kindName(Kind k) internal pure returns (string memory) {
        return k == Kind.Eth ? "eth" : k == Kind.Pcs ? "pcs" : "usdc";
    }

    function _floor(int24 t, int24 spacing) internal pure returns (int24) {
        int24 r = (t / spacing) * spacing;
        if (t < 0 && r != t) r -= spacing;
        return r;
    }

    function _mineHookSalt(address poolManager, address builderAddr) internal pure returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(RaceLaunchHook).creationCode, abi.encode(poolManager, builderAddr)));
        uint160 want = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        for (uint256 i; i < 2_000_000; ++i) {
            address h = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), builderAddr, bytes32(i), initHash)))));
            if (uint160(h) & Hooks.ALL_HOOK_MASK == want) return bytes32(i);
        }
        revert("no hook salt found");
    }
}
