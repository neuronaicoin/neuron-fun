// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";

import {DeployRace} from "../script/race/DeployRace.s.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {RaceBuilderEth} from "../src/race/RaceBuilderEth.sol";
import {RaceBuilderPcs} from "../src/race/RaceBuilderPcs.sol";
import {RaceBuilder} from "../src/race/RaceBuilder.sol";
import {RaceTradeEth} from "../src/race/RaceTradeEth.sol";
import {RaceTradePcs} from "../src/race/RaceTradePcs.sol";
import {TestUsdV7, TestFeed} from "../src/race/testnet/TestnetSupport.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {MockWBNB} from "./RacePcsFlow.t.sol";

/// The deploy script, run as it will run on a testnet (TESTNET=true, every kind), against
/// local Uniswap v4 / PancakeSwap Infinity: it must come up with the right contracts, the
/// addresses it predicted, a seeded dollar pool, and a coin must launch and trade on it.
contract DeployRaceTest is Test, DeployPermit2 {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant DEPLOYER_KEY = 0xA11CE;
    uint256 constant FACTORY_KEY = 0xFAC7;
    address deployer = vm.addr(DEPLOYER_KEY);
    address creator = address(0xC4EA);
    address alice = address(0xA1);
    string dir;

    MockLzEndpoint ep;

    function setUp() public {
        vm.warp(1_800_000_000);
        // the script's permit2 is the canonical address
        address p = deployPermit2();
        vm.etch(PERMIT2, p.code);
        ep = new MockLzEndpoint(40_001);
        vm.deal(deployer, 10 ether);
        dir = string.concat(vm.projectRoot(), "/deployments/test-", vm.toString(block.timestamp), "/");
        vm.createDir(dir, true);
        vm.setEnv("DEPLOY_DIR", dir);
        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("RACE_FACTORY_KEY", vm.toString(FACTORY_KEY));
        vm.setEnv("LZ_ENDPOINT", vm.toString(address(ep)));
        vm.setEnv("LOCAL_EID", "40001");
        vm.setEnv("COORD_EID", "40001");
        vm.setEnv("TESTNET", "true");
        vm.setEnv("USD_TOKEN", "");
        vm.setEnv("PRICE_FEED", "");
        vm.setEnv("ACROSS_SPOKE", "");
        vm.setEnv("SEED_WEI", "50000000000000000"); // 0.05
    }

    function _v4() internal returns (address pm, address posm) {
        pm = deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this)));
        posm = deployCode("out/PositionManager.sol/PositionManager.json",
            abi.encode(pm, PERMIT2, uint256(300_000), IPositionDescriptor(address(0)), IWETH9(address(0))));
    }

    function _read(string memory k) internal view returns (address) {
        string memory j = vm.readFile(string.concat(dir, vm.toString(block.chainid), ".json"));
        return vm.parseJsonAddress(j, string.concat(".", k));
    }

    function _launch(address factory, address usd) internal returns (address coin) {
        uint32[] memory eids = new uint32[](1);
        eids[0] = 40_001;
        vm.prank(deployer); // WireRace does this on a real chain
        RaceFactory(factory).setLaunchesOpen(true);
        TestUsdV7(usd).faucet(creator);
        vm.startPrank(creator);
        IERC20(usd).approve(factory, type(uint256).max);
        (coin,) = RaceFactory(factory).launch(RaceFactory.Launch("Moon Cat", "MCAT", "", "", bytes32("k1"), eids, 0, 5e6, 0));
        vm.stopPrank();
        assertGt(IERC20(coin).balanceOf(creator), 0, "creator got coins");
    }

    function test_deployEth() public {
        (address pm, address posm) = _v4();
        vm.setEnv("BUILDER_KIND", "eth");
        vm.setEnv("POOL_MANAGER", vm.toString(pm));
        vm.setEnv("POSITION_MANAGER", vm.toString(posm));
        vm.setEnv("DOLLAR_FEE", "500");
        vm.setEnv("DOLLAR_SPACING", "10");
        new DeployRace().run();
        address factory = _read("factory");
        address usd = _read("usd");
        RaceBuilderEth b = RaceBuilderEth(payable(_read("builder")));
        assertEq(address(b.poolManager()), pm);
        assertEq(b.factory(), factory);
        assertEq(TestFeed(_read("feed")).answer(), 2_500e8);
        assertGt(IPoolManager(pm).getLiquidity(b.dollarPoolKey().toId()), 0, "dollar pool seeded");
        address coin = _launch(factory, usd);
        // a user buys with dollars through the trade router
        RaceTradeEth t = RaceTradeEth(_read("router"));
        TestUsdV7(usd).faucet(alice);
        vm.startPrank(alice);
        IERC20(usd).approve(address(t), type(uint256).max);
        uint256 got = t.buy(coin, 20e6, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(got, 0, "bought with USDC through ETH");
    }

    function test_deployPcs() public {
        Vault v = new Vault();
        CLPoolManager p = new CLPoolManager(IVault(address(v)));
        v.registerApp(address(p));
        MockWBNB w = new MockWBNB();
        vm.setEnv("BUILDER_KIND", "pcs");
        vm.setEnv("VAULT", vm.toString(address(v)));
        vm.setEnv("CL_POOL_MANAGER", vm.toString(address(p)));
        vm.setEnv("WNATIVE", vm.toString(address(w)));
        vm.setEnv("DOLLAR_POOL", "");
        new DeployRace().run();
        address factory = _read("factory");
        address usd = _read("usd");
        RaceBuilderPcs b = RaceBuilderPcs(payable(_read("builder")));
        assertEq(address(b.vault()), address(v));
        assertEq(address(b.dollarPool()), _read("dollarPool"));
        assertEq(w.balanceOf(_read("dollarPool")), 0.05 ether, "BNB seeded");
        address coin = _launch(factory, usd);
        RaceTradePcs t = RaceTradePcs(payable(_read("router")));
        TestUsdV7(usd).faucet(alice);
        vm.startPrank(alice);
        IERC20(usd).approve(address(t), type(uint256).max);
        uint256 got = t.buy(coin, 20e6, 1, alice, block.timestamp);
        vm.stopPrank();
        assertGt(got, 0, "bought with USDC through BNB");
    }

    function test_deployUsdc() public {
        (address pm, address posm) = _v4();
        vm.setEnv("BUILDER_KIND", "usdc");
        vm.setEnv("POOL_MANAGER", vm.toString(pm));
        vm.setEnv("POSITION_MANAGER", vm.toString(posm));
        new DeployRace().run();
        RaceBuilder b = RaceBuilder(_read("builder"));
        assertEq(b.factory(), _read("factory"));
        _launch(_read("factory"), _read("usd"));
    }

    function test_refusesUsedFactoryWallet() public {
        (address pm, address posm) = _v4();
        vm.setEnv("BUILDER_KIND", "usdc");
        vm.setEnv("POOL_MANAGER", vm.toString(pm));
        vm.setEnv("POSITION_MANAGER", vm.toString(posm));
        vm.setNonce(vm.addr(FACTORY_KEY), 1);
        DeployRace d = new DeployRace();
        vm.expectRevert(bytes("RACE_FACTORY_KEY wallet was used before: needs nonce 0 on every chain"));
        d.run();
    }
}
