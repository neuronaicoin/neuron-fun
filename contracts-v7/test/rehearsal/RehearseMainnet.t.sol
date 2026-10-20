// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployRace} from "../../script/race/DeployRace.s.sol";
import {WireRace} from "../../script/race/WireRace.s.sol";
import {RaceFactory} from "../../src/race/RaceFactory.sol";
import {AcrossUsdBridge} from "../../src/omni/AcrossUsdBridge.sol";
import {RaceCross, IRaceRouter} from "../../src/race/RaceCross.sol";
import {AutoOrders} from "../../src/auto/AutoOrders.sol";

/**
 * Mainnet dress rehearsal, nothing is sent anywhere: copies of the four REAL chains (Base, BNB
 * Chain, Robinhood Chain, Arc) are made in memory, then exactly what the mainnet deploy will do
 * runs on them with the real settings: DeployRace on each chain, WireRace on each chain (with
 * the two-step Across route BNB Chain <-> Robinhood Chain through Base), and a coin launched on
 * all four chains, which must land at the same address everywhere and pay the race fee.
 *
 * Runs only with REHEARSE=true and the LayerZero addresses in env (the deploy-race-mainnet
 * workflow, mode "rehearsal", sets both). Fresh throwaway keys, funded in the copies only.
 */
contract RehearseMainnetTest is Test {
    struct Net {
        uint256 id;
        string rpc;
        string kind;
        address usd;
        uint8 usdDec;
        address feed;
        uint256 maxFeedAge;
        address across;
        // eth / usdc
        address pm;
        address posm;
        uint256 dollarFee;
        uint256 dollarSpacing;
        // pcs
        address vault;
        address clpm;
        address wnative;
        address dollarPool;
        string hopFor; // remote chain reached through Base
    }

    address constant TREASURY = 0x3C4E66b4B4DDD1F6348aD5fDfAE7e60AC35aca6F;
    uint256 constant COORD_EID = 30184; // Base decides the races
    // throwaway keys: never used on any real chain (nonce 0 everywhere, as the factory key must be)
    uint256 constant DEPLOYER_KEY = uint256(keccak256("sasa mainnet rehearsal: deployer v1"));
    uint256 constant FACTORY_KEY = uint256(keccak256("sasa mainnet rehearsal: factory v1"));
    uint256 constant CREATOR_KEY = uint256(keccak256("sasa mainnet rehearsal: creator v1"));

    Net[4] chains;
    uint256[4] forks;
    string dir;

    function _chains() internal {
        chains[0] = Net(8453, "https://mainnet.base.org", "eth", 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 6,
            0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 2 hours, 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64,
            0x498581fF718922c3f8e6A244956aF099B2652b2b, 0x7C5f5A4bBd8fD63184577525326123B519429bDc, 3000, 60,
            address(0), address(0), address(0), address(0), "");
        chains[1] = Net(4663, "https://rpc.mainnet.chain.robinhood.com", "eth", 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 6,
            // Chainlink updates ETH/USD here once a day: 26 hours of slack
            0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9, 26 hours, 0xD29C85F15DF544bA632C9E25829fd29d767d7978,
            0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x58daec3116aae6D93017bAAea7749052E8a04fA7, 500, 10,
            address(0), address(0), address(0), address(0), "56");
        chains[2] = Net(5042, "https://rpc.mainnet.arc.io", "usdc", 0x3600000000000000000000000000000000000000, 6,
            address(0), 2 hours, 0x9b4A302A548c7e313c2b74C461db7b84d3074A84,
            0x8366a39CC670B4001A1121B8F6A443A643e40951, 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B, 0, 0,
            address(0), address(0), address(0), address(0), "");
        // BNB Chain last: its public nodes keep old state only briefly, so its copy is made last
        chains[3] = Net(56, "https://bsc-dataseed.bnbchain.org", "pcs", 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d, 18,
            0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE, 2 hours, 0x4e8E101924eDE233C13e2D8622DC8aED2872d505,
            address(0), address(0), 0, 0,
            0x238a358808379702088667322f80aC48bAd5e6c4, 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b,
            0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c, 0xf2688Fb5B81049DFB7703aDa5e770543770612C4, "4663");
    }

    function _lz(uint256 id, string memory what) internal view returns (string memory) {
        return vm.envString(string.concat("LZ_", vm.toString(id), "_", what));
    }

    function _unit(Net memory c) internal pure returns (uint256) {
        return 10 ** c.usdDec;
    }

    function _envDeploy(Net memory c) internal {
        vm.setEnv("BUILDER_KIND", c.kind);
        vm.setEnv("TESTNET", "false");
        vm.setEnv("LZ_ENDPOINT", _lz(c.id, "ENDPOINT"));
        vm.setEnv("LOCAL_EID", _lz(c.id, "EID"));
        vm.setEnv("COORD_EID", vm.toString(COORD_EID));
        vm.setEnv("USD_TOKEN", vm.toString(c.usd));
        vm.setEnv("PRICE_FEED", c.feed == address(0) ? "" : vm.toString(c.feed));
        vm.setEnv("MAX_FEED_AGE", vm.toString(c.maxFeedAge));
        vm.setEnv("ACROSS_SPOKE", vm.toString(c.across));
        vm.setEnv("TREASURY", vm.toString(TREASURY));
        vm.setEnv("KEEPER", vm.toString(vm.addr(DEPLOYER_KEY)));
        vm.setEnv("MIN_DVNS", "1");
        // $3,000 launch market cap, always in 6-decimal dollars (the builders' unit, on every chain:
        // BNB Chain's 18-decimal USDC here once made its races undecidable); $1 smallest first buy
        // and $0.50 race fee in this chain's dollar units
        vm.setEnv("START_MC", vm.toString(uint256(3_000e6)));
        vm.setEnv("MIN_FIRST_BUY", vm.toString(_unit(c)));
        vm.setEnv("RACE_FEE", vm.toString(_unit(c) / 2));
        vm.setEnv("POOL_MANAGER", c.pm == address(0) ? "" : vm.toString(c.pm));
        vm.setEnv("POSITION_MANAGER", c.posm == address(0) ? "" : vm.toString(c.posm));
        vm.setEnv("DOLLAR_FEE", vm.toString(c.dollarFee));
        vm.setEnv("DOLLAR_SPACING", vm.toString(c.dollarSpacing));
        vm.setEnv("VAULT", c.vault == address(0) ? "" : vm.toString(c.vault));
        vm.setEnv("CL_POOL_MANAGER", c.clpm == address(0) ? "" : vm.toString(c.clpm));
        vm.setEnv("WNATIVE", c.wnative == address(0) ? "" : vm.toString(c.wnative));
        vm.setEnv("DOLLAR_POOL", c.dollarPool == address(0) ? "" : vm.toString(c.dollarPool));
        // trades here with dollars kept on Base (not deployed on Base itself)
        vm.setEnv("CROSS_HOME_CHAIN_ID", "8453");
        vm.setEnv("CROSS_HOME_USDC", vm.toString(chains[0].usd));
        // top up gas below ~12 cents: ETH on Robinhood, BNB on BNB Chain, USDC (token units) on Arc
        vm.setEnv("CROSS_GAS_FLOOR", c.id == 4663 ? "50000000000000" : c.id == 56 ? "200000000000000" : "100000");
    }

    function _deploy(uint256 i) internal {
        Net memory c = chains[i];
        forks[i] = vm.createSelectFork(c.rpc);
        require(block.chainid == c.id, "RPC answered for another chain");
        vm.deal(vm.addr(DEPLOYER_KEY), 100 ether);
        vm.deal(vm.addr(FACTORY_KEY), 1 ether);
        _envDeploy(c);
        console2.log("== deploy on chain", c.id);
        new DeployRace().run();
    }

    function _wire(uint256 i) internal {
        Net memory c = chains[i];
        vm.selectFork(forks[i]);
        string memory others;
        for (uint256 k; k < 4; ++k) {
            if (k == i) continue;
            others = bytes(others).length == 0 ? vm.toString(chains[k].id) : string.concat(others, ",", vm.toString(chains[k].id));
        }
        vm.setEnv("REMOTE_CHAIN_IDS", others);
        vm.setEnv("SEND_LIB", _lz(c.id, "SEND"));
        vm.setEnv("RECEIVE_LIB", _lz(c.id, "RECV"));
        vm.setEnv("EXECUTOR", _lz(c.id, "EXEC"));
        vm.setEnv("DVNS", _lz(c.id, "DVNS"));
        vm.setEnv("CONFIRMATIONS", vm.envOr("CONFIRMATIONS", string("15")));
        vm.setEnv("LOCK_BRIDGE", "true");
        vm.setEnv("OPEN_LAUNCHES", "true");
        vm.setEnv("ALLOW_MISSING_ROUTES", "false");
        vm.setEnv("ACROSS_HOP_FOR", c.hopFor);
        vm.setEnv("ACROSS_HOP_CHAIN_ID", bytes(c.hopFor).length > 0 ? "8453" : "");
        console2.log("== wire on chain", c.id);
        new WireRace().run();
    }

    function _json(uint256 id) internal view returns (string memory) {
        return vm.readFile(string.concat(dir, vm.toString(id), ".json"));
    }

    /// The same coin launched on this chain (all four picked). False if the chain's dollar
    /// can't be moved inside the test tool (Arc's USDC is the chain's own money).
    function _launch(uint256 i, uint32[] memory eids) internal returns (bool ok, address coin) {
        Net memory c = chains[i];
        vm.selectFork(forks[i]);
        RaceFactory f = RaceFactory(vm.parseJsonAddress(_json(c.id), ".factory"));
        address creator = vm.addr(CREATOR_KEY);
        uint256 need = f.minFirstBuy() + f.raceFee();
        if (c.id == 5042) vm.deal(creator, 100 ether); // Arc: USDC is the native balance (18 decimals there)
        else deal(c.usd, creator, 100 * _unit(c));
        if (IERC20(c.usd).balanceOf(creator) < need) {
            console2.log("chain", c.id, ": the test tool can't hand out this chain's dollar; launch not simulated");
            return (false, address(0));
        }
        vm.prank(creator);
        IERC20(c.usd).approve(address(f), type(uint256).max);
        assertEq(f.raceFeeTo(), vm.addr(DEPLOYER_KEY), "race fee goes to the keeper");
        uint256 t0 = IERC20(c.usd).balanceOf(f.raceFeeTo());
        RaceFactory.Launch memory l = RaceFactory.Launch("Rehearsal Cat", "RCAT", "", "", bytes32("rehearsal-1"), eids, 0, f.minFirstBuy(), 0);
        vm.prank(creator);
        try f.launch(l) returns (address got, address) {
            coin = got;
        } catch (bytes memory err) {
            if (c.id == 5042) {
                console2.log("Arc: launch can't run inside the test tool (Arc's built-in USDC); checked live instead");
                console2.logBytes(err);
                return (false, address(0));
            }
            assembly { revert(add(err, 32), mload(err)) }
        }
        assertEq(coin, f.coinAddress(creator, bytes32("rehearsal-1")), "coin at the predicted address");
        assertGt(IERC20(coin).balanceOf(creator), 0, "creator got coins from the first buy");
        assertGe(IERC20(c.usd).balanceOf(f.raceFeeTo()) - t0, f.raceFee(), "race fee reached the keeper");
        console2.log("launched on chain", c.id, "coin", coin);
        return (true, coin);
    }

    function test_rehearseMainnet() public {
        if (!vm.envOr("REHEARSE", false)) {
            vm.skip(true);
            return;
        }
        _chains();
        dir = string.concat(vm.projectRoot(), "/deployments/rehearsal-", vm.toString(vm.unixTime()), "/");
        vm.createDir(dir, true);
        vm.setEnv("DEPLOY_DIR", dir);
        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("RACE_FACTORY_KEY", vm.toString(FACTORY_KEY));
        vm.setEnv("ADMIN", "");

        // 1. deploy on Base, Robinhood, Arc; then BNB Chain, wired and launched right away
        for (uint256 i; i < 3; ++i) _deploy(i);
        _deploy(3);
        _wire(3);

        uint32[] memory eids = new uint32[](4);
        for (uint256 i; i < 4; ++i) eids[i] = uint32(vm.parseJsonUint(_json(chains[i].id), ".eid"));
        _sort(eids);
        (bool okBnb, address coinBnb) = _launch(3, eids);
        assertTrue(okBnb, "BNB Chain launch");
        _crossTrade(3, coinBnb); // right away: BNB Chain's public nodes forget old state quickly
        _crossLaunch(3, eids);
        _autoSell(3, coinBnb); // take profit on BNB Chain through the real race router

        // 2. wire and launch on the other three
        for (uint256 i; i < 3; ++i) _wire(i);
        address factory = vm.parseJsonAddress(_json(chains[0].id), ".factory");
        for (uint256 i; i < 4; ++i) {
            assertEq(vm.parseJsonAddress(_json(chains[i].id), ".factory"), factory, "same factory address on every chain");
        }
        uint256 launched = 1;
        for (uint256 i; i < 3; ++i) {
            (bool ok, address coin) = _launch(i, eids);
            if (!ok) continue;
            assertEq(coin, coinBnb, "same coin address on every chain");
            launched++;
        }
        assertGe(launched, 3, "the coin went live on at least Base, Robinhood Chain and BNB Chain");

        // 3. the Across routes: BNB Chain <-> Robinhood Chain go through Base, the rest direct
        _checkRoutes(eids);

        // 4. trading from Base: the REAL SpokePool delivers dollars to RaceCross, which buys
        //    (topping up gas); the user then sells and the dollars leave for Base through Across
        assertEq(vm.parseJsonAddress(_json(8453), ".cross"), address(0), "no cross contract on Base itself");
        _crossTrade(1, coinBnb); // Robinhood Chain
        _crossLaunch(1, eids);
        _autoDipCross(coinBnb); // buy the dip from Base for the coin on Robinhood Chain, through the real SpokePool
        console2.log("REHEARSAL OK: chains deployed 4, wired 4, coin launched on", launched);
    }

    function _crossTrade(uint256 i, address coin) internal {
        Net memory c = chains[i];
        vm.selectFork(forks[i]);
        address x = vm.parseJsonAddress(_json(c.id), ".cross");
        assertTrue(x != address(0), "cross contract deployed");
        address user = vm.addr(uint256(keccak256(abi.encode("sasa rehearsal: cross user", c.id))));
        uint256 amount = 20 * _unit(c);
        // what Across's relayer does: pay the contract, then the SpokePool calls it
        deal(c.usd, x, amount);
        vm.prank(c.across);
        RaceCross(payable(x)).handleV3AcrossMessage(c.usd, amount, address(0xF111),
            abi.encode(uint8(0), abi.encode(RaceCross.Order(user, coin, 1, (30 * _unit(c)) / 100, block.timestamp + 1 hours))));
        uint256 coins = IERC20(coin).balanceOf(user);
        assertGt(coins, 0, "coins bought from Base dollars");
        assertGt(user.balance, 0, "gas topped up");
        assertEq(IERC20(c.usd).balanceOf(x), 0, "cross contract keeps nothing");
        // sell: the dollars go into the real SpokePool, bound for the user's address on Base
        uint256 spoke0 = IERC20(c.usd).balanceOf(c.across);
        vm.startPrank(user);
        IERC20(coin).approve(x, coins);
        uint256 got = RaceCross(payable(x)).sellAndSendHome(coin, coins, 1, _unit(c) / 100, block.timestamp);
        vm.stopPrank();
        assertGt(got, 12 * _unit(c), "sold for most of it (opening fee still 10% each way here)");
        assertEq(IERC20(c.usd).balanceOf(c.across) - spoke0, got, "dollars handed to Across for Base");
        console2.log("cross trade ok on chain", c.id, "gas wei", user.balance);
    }


    /// A sasa account (dollars on Base) launches here through Across: the real factory, pools and
    /// all four chains picked, with the user's signature. Also measures the fill's gas.
    function _crossLaunch(uint256 i, uint32[] memory eids) internal {
        Net memory c = chains[i];
        vm.selectFork(forks[i]);
        RaceCross x = RaceCross(payable(vm.parseJsonAddress(_json(c.id), ".cross")));
        RaceFactory f = RaceFactory(vm.parseJsonAddress(_json(c.id), ".factory"));
        assertEq(f.launcher(), address(x), "RaceCross is the factory's launcher");
        uint256 pk = uint256(keccak256(abi.encode("sasa rehearsal: cross creator", c.id)));
        address user = vm.addr(pk);
        RaceFactory.Launch memory l =
            RaceFactory.Launch("Rehearsal Dog", "RDOG", "", "", bytes32("rehearsal-2"), eids, 0, f.minFirstBuy(), 0);
        uint256 dl = vm.getBlockTimestamp() + 15 minutes;
        uint256 gasUsd = (30 * _unit(c)) / 100;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, x.launchDigest(user, l, gasUsd, dl));
        bytes memory m = abi.encode(uint8(1), abi.encode(RaceCross.LaunchOrder(user, l, gasUsd, dl, abi.encodePacked(r, sg, v))));
        uint256 amount = f.minFirstBuy() + f.raceFee() + _unit(c); // $1 first buy + 50c fee + $1 for gas and change
        deal(c.usd, address(x), amount);
        assertEq(f.raceFeeTo(), vm.addr(DEPLOYER_KEY), "race fee goes to the keeper");
        uint256 t0 = IERC20(c.usd).balanceOf(f.raceFeeTo());
        vm.prank(c.across);
        uint256 g0 = gasleft();
        x.handleV3AcrossMessage(c.usd, amount, address(0xF111), m);
        uint256 used = g0 - gasleft();
        address coin = f.coinAddress(user, bytes32("rehearsal-2"));
        assertGt(coin.code.length, 0, "launched through Across");
        assertGt(IERC20(coin).balanceOf(user), 0, "first-buy coins are the creator's");
        assertGt(user.balance, 0, "gas topped up");
        assertEq(IERC20(c.usd).balanceOf(user), amount - f.minFirstBuy() - f.raceFee() - gasUsd, "change back to the creator");
        assertGe(IERC20(c.usd).balanceOf(f.raceFeeTo()) - t0, f.raceFee(), "race fee reached the keeper");
        assertEq(IERC20(c.usd).balanceOf(address(x)), 0, "cross contract keeps nothing");
        assertLt(used, 9_000_000, "a launch fill fits easily in a block");
        console2.log("cross launch ok on chain", c.id, "fill gas", used);
    }


    /// A take profit order on a real chain: the user signs, the keeper executes through the race
    /// router, the user gets at least the minimum, the keeper the 0.1% fee, the contract nothing.
    function _autoSell(uint256 i, address coin) internal {
        Net memory c = chains[i];
        vm.selectFork(forks[i]);
        AutoOrders ao = AutoOrders(vm.parseJsonAddress(_json(c.id), ".autoOrders"));
        address router = vm.parseJsonAddress(_json(c.id), ".router");
        assertTrue(ao.allowedTarget(router), "race router allowed");
        uint256 pk = uint256(keccak256(abi.encode("sasa rehearsal: auto user", c.id)));
        address user = vm.addr(pk);
        deal(c.usd, user, 10 * _unit(c));
        vm.startPrank(user);
        IERC20(c.usd).approve(router, type(uint256).max);
        uint256 coins = IRaceRouter(router).buy(coin, 10 * _unit(c), 1, user, block.timestamp);
        IERC20(coin).approve(address(ao), type(uint256).max);
        vm.stopPrank();
        AutoOrders.Order memory o = AutoOrders.Order(user, coin, c.usd, coins, 1, 0, 0, 0, block.timestamp + 1 days, 1);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, ao.digest(o));
        AutoOrders.Route memory route =
            AutoOrders.Route(router, router, abi.encodeCall(IRaceRouter.sell, (coin, coins, 0, address(ao), block.timestamp + 60)), 0);
        uint256 fee0 = IERC20(c.usd).balanceOf(ao.feeTo());
        vm.prank(vm.addr(DEPLOYER_KEY)); // the rehearsal's keeper
        uint256 out = ao.execute(o, abi.encodePacked(r, s_, v), route);
        assertEq(IERC20(c.usd).balanceOf(user), out, "sold for the user");
        assertGt(out, 7 * _unit(c), "most of the $10 back (opening fee aside)");
        assertApproxEqAbs(IERC20(c.usd).balanceOf(ao.feeTo()) - fee0, (out * 10) / 9_990, 1, "0.1% fee to the keeper");
        assertEq(IERC20(c.usd).balanceOf(address(ao)), 0, "nothing kept");
        console2.log("auto order (take profit) ok on chain", c.id);
    }

    /// Buy the dip from Base for a coin raced on Robinhood Chain: the dollars go into Base's real
    /// SpokePool, bound for Robinhood Chain's RaceCross.
    function _autoDipCross(address coin) internal {
        Net memory c = chains[0];
        vm.selectFork(forks[0]);
        AutoOrders ao = AutoOrders(vm.parseJsonAddress(_json(c.id), ".autoOrders"));
        address hoodCross = vm.parseJsonAddress(_json(4663), ".cross");
        assertEq(ao.crossRouteOf(4663).raceCross, hoodCross, "dip buys to Robinhood Chain wired");
        uint256 pk = uint256(keccak256("sasa rehearsal: auto dip user"));
        address user = vm.addr(pk);
        deal(c.usd, user, 20 * _unit(c));
        vm.prank(user);
        IERC20(c.usd).approve(address(ao), type(uint256).max);
        AutoOrders.Order memory o = AutoOrders.Order(user, c.usd, coin, 20 * _unit(c), 1, 2, 4663, _unit(c), block.timestamp + 1 days, 2);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, ao.digest(o));
        uint256 spoke0 = IERC20(c.usd).balanceOf(c.across);
        vm.prank(vm.addr(DEPLOYER_KEY));
        ao.execute(o, abi.encodePacked(r, s_, v), AutoOrders.Route(address(0), address(0), "", _unit(c) / 20));
        uint256 sent = 20 * _unit(c) - (20 * _unit(c) * 10) / 10_000;
        assertEq(IERC20(c.usd).balanceOf(c.across) - spoke0, sent, "dollars handed to Across for Robinhood Chain");
        assertEq(IERC20(c.usd).balanceOf(user), 0);
        assertEq(IERC20(c.usd).balanceOf(address(ao)), 0, "nothing kept");
        console2.log("auto order (dip buy via Across) ok from Base");
    }

    function _checkRoutes(uint32[] memory) internal {
        for (uint256 i; i < 4; ++i) {
            vm.selectFork(forks[i]);
            AcrossUsdBridge b = AcrossUsdBridge(vm.parseJsonAddress(_json(chains[i].id), ".bridge"));
            assertTrue(b.locked(), "bridge locked");
            for (uint256 k; k < 4; ++k) {
                if (k == i) continue;
                uint32 eid = uint32(vm.parseJsonUint(_json(chains[k].id), ".eid"));
                (uint256 chainId, address out, address twin, uint8 dec, bool viaHop) = b.routes(eid);
                bool hop = (chains[i].id == 56 && chains[k].id == 4663) || (chains[i].id == 4663 && chains[k].id == 56);
                assertEq(viaHop, hop, "two-step only between BNB Chain and Robinhood Chain");
                uint256 to = hop ? 8453 : chains[k].id;
                assertEq(chainId, to, "route chain");
                uint256 toIdx = hop ? 0 : k;
                assertEq(out, chains[toIdx].usd, "route dollar");
                assertEq(dec, chains[toIdx].usdDec, "route decimals");
                assertEq(twin, vm.parseJsonAddress(_json(chains[toIdx].id), ".bridge"), "route twin");
            }
        }
    }

    function _sort(uint32[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            uint32 v = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > v) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = v;
        }
    }
}
