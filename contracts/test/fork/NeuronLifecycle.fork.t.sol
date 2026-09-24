// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PairPadFeeEscrow} from "../../src/v2/PairPadFeeEscrow.sol";
import {PairPadQuotePricer, IUniswapV3FactoryMinimal} from "../../src/v2/PairPadQuotePricer.sol";
import {PonsReferenceRegistry, IPonsV2LaunchFactory} from "../../src/v2/PairPadReferenceRegistries.sol";
import {PairPadLaunchLocker} from "../../src/v2/PairPadLaunchLocker.sol";
import {PairPadLaunchFactory} from "../../src/v2/PairPadLaunchFactory.sol";
import {PairPadPositionMinter} from "../../src/v2/PairPadPositionMinter.sol";
import {PairPadLaunchDeployer} from "../../src/v2/PairPadLaunchDeployer.sol";
import {PairPadRouter, ISwapRouter02, IWETH9} from "../../src/v2/PairPadRouter.sol";
import {PairPadLauncherToken} from "../../src/v2/PairPadLauncherToken.sol";
import {IPairPadFeeEscrow} from "../../src/v2/interfaces/ILaunchpadV2.sol";

import {NeuronParentRegistry} from "../../src/neuron/NeuronParentRegistry.sol";
import {NeuronParentSplitter, INeuronSwapRouter} from "../../src/neuron/NeuronParentSplitter.sol";
import {NeuronLauncher, INeuronLaunchFactory, INeuronRegistryListing} from "../../src/neuron/NeuronLauncher.sol";

/**
 * @notice Neuron.fun end to end on a fork of Robinhood Chain mainnet (4663):
 * the real Uniswap v4 PoolManager and PositionManager, the par stack deployed
 * fresh, and the Neuron.fun contracts on top. Run with:
 *
 *   forge test --match-path "test/fork/Neuron*" --fork-url robinhood
 *
 * Skipped automatically when no fork is active.
 */
contract NeuronLifecycleForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    /// @dev A PONS graduate whose market is a hooked v4 ETH pool.
    address constant BLOKKS = 0x66e73ef65528Baf192679222c6D2810D7D7e2c68;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint256 constant PHANTOM = 1.3557 ether;
    /// @dev Of the 1% base fee: 40% protocol, 60% creator side.
    uint256 constant PROTOCOL_SHARE_BPS = 4_000;
    /// @dev Of the creator side: half to the Parent.
    uint16 constant PARENT_SHARE_BPS = 5_000;

    IPoolManager manager = IPoolManager(POOL_MANAGER);
    PairPadFeeEscrow feeEscrow;
    PairPadQuotePricer quotePricer;
    PonsReferenceRegistry ponsRegistry;
    PairPadLaunchLocker locker;
    PairPadLaunchFactory factory;
    PairPadRouter router;
    NeuronParentRegistry registry;
    NeuronLauncher launcher;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address creator = makeAddr("creator");
    address buyer = makeAddr("buyer");
    address protocolFees = makeAddr("protocolFees");

    address neuron; // the platform token, launched on our own factory

    receive() external payable {}

    function setUp() public {
        if (block.chainid != 4663) return;

        // --- par stack, as in par's own fork tests ---
        feeEscrow = new PairPadFeeEscrow();
        quotePricer =
            new PairPadQuotePricer(address(this), IUniswapV3FactoryMinimal(V3_FACTORY), WETH, USDG, manager);
        quotePricer.setV4HookAllowed(PONS_HOOK, true);
        ponsRegistry = new PonsReferenceRegistry(IPonsV2LaunchFactory(PONS_FACTORY), IHooks(PONS_HOOK));
        quotePricer.addRegistry(ponsRegistry);
        locker = new PairPadLaunchLocker(
            address(this), IPositionManager(POSITION_MANAGER), IPairPadFeeEscrow(address(feeEscrow))
        );
        factory = new PairPadLaunchFactory(
            address(this),
            manager,
            IPositionManager(POSITION_MANAGER),
            locker,
            IPairPadFeeEscrow(address(feeEscrow)),
            quotePricer,
            protocolFees,
            0
        );
        PairPadPositionMinter minter = new PairPadPositionMinter(
            IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), locker, address(factory)
        );
        PairPadLaunchDeployer launchDeployer = new PairPadLaunchDeployer(address(factory));
        router = new PairPadRouter(manager, factory, ISwapRouter02(SWAP_ROUTER_02), IWETH9(WETH));

        locker.setFactory(address(factory));
        factory.setPositionMinter(minter);
        factory.setLaunchDeployer(launchDeployer);
        factory.addLaunchConfig(
            PairPadLaunchFactory.LaunchConfig({supply: SUPPLY, phantomQuote: PHANTOM, tickSpacing: 10, enabled: true})
        );
        factory.setProtocolFeeShareBps(PROTOCOL_SHARE_BPS);
        factory.setLaunchEnabled(true);

        // --- Neuron.fun on top ---
        registry = new NeuronParentRegistry(owner, operator);
        launcher = new NeuronLauncher(
            owner,
            INeuronLaunchFactory(address(factory)),
            INeuronSwapRouter(address(router)),
            INeuronRegistryListing(address(registry)),
            IPairPadFeeEscrow(address(feeEscrow)),
            PARENT_SHARE_BPS
        );
        factory.setLaunchForwarder(address(launcher));

        vm.deal(creator, 100 ether);
        vm.deal(buyer, 100 ether);

        // The platform token is the first launch on the factory, straight
        // against ETH, and becomes the first Parent.
        (neuron,) = factory.launchToken(_params("NEURON", "neuron"), 0, address(0));
        PoolKey memory neuronRoute = factory.poolKeyFor(neuron);
        vm.prank(owner);
        registry.setParent(neuron, neuronRoute);
    }

    modifier onlyFork() {
        if (block.chainid != 4663) vm.skip(true);
        _;
    }

    function _params(string memory symbol, bytes32 salt)
        internal
        pure
        returns (PairPadLaunchFactory.TokenParams memory)
    {
        return PairPadLaunchFactory.TokenParams({
            name: symbol,
            symbol: symbol,
            logo: "",
            description: "neuron fork e2e",
            socials: PairPadLauncherToken.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            expectedEconomics: bytes32(0),
            salt: salt
        });
    }

    function _launchChild(address parent, uint256 devBuy)
        internal
        returns (address child, NeuronParentSplitter splitter, uint256 devTokens)
    {
        vm.prank(creator);
        address s;
        (child, s, devTokens) = launcher.launch{value: devBuy}(_params("CHILD", "child"), parent, 0);
        splitter = NeuronParentSplitter(payable(s));
    }

    function _buy(address token, address who, uint256 ethIn) internal returns (uint256 out) {
        PoolKey memory key = factory.poolKeyFor(token);
        vm.prank(who);
        out = router.swapExactIn{value: ethIn}(key, true, ethIn, 0, who);
    }

    function _sell(address token, address who, uint256 tokensIn) internal returns (uint256 out) {
        PoolKey memory key = factory.poolKeyFor(token);
        vm.startPrank(who);
        IERC20(token).approve(address(router), tokensIn);
        out = router.swapExactIn(key, false, tokensIn, 0, who);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------

    function test_fork_launchWiresEverything() public onlyFork {
        (address child, NeuronParentSplitter splitter, uint256 devTokens) = _launchChild(neuron, 0.1 ether);

        assertEq(factory.getLaunchedToken(child).creatorFeeRecipient, address(splitter));
        assertEq(factory.getLaunchedToken(child).deployer, creator);
        assertEq(factory.getLaunchedToken(child).protocolFeeShareBps, PROTOCOL_SHARE_BPS);
        assertEq(splitter.child(), child);
        assertEq(splitter.parent(), neuron);
        assertEq(splitter.creator(), creator);
        assertGt(devTokens, 0);
        assertEq(IERC20(child).balanceOf(creator), devTokens);
        assertEq(address(launcher).balance, 0);
    }

    function test_fork_feesFlowToCreatorAndBurnTheParent() public onlyFork {
        (address child, NeuronParentSplitter splitter,) = _launchChild(neuron, 0);

        // Trading: 1 ETH in, then half the tokens back out.
        uint256 bought = _buy(child, buyer, 1 ether);
        _sell(child, buyer, bought / 2);

        uint256 protocolBefore = protocolFees.balance;
        locker.collectFees(child);

        // The buy paid 1% of 1 ETH in ETH: 40% of it to the protocol,
        // 60% credited to the splitter. Uniswap rounds, so compare loosely.
        uint256 ethFee = 0.01 ether;
        assertApproxEqRel(protocolFees.balance - protocolBefore, ethFee * 40 / 100, 0.01e18);
        (uint256 escrowEth, uint256 escrowTokens) = splitter.pendingInEscrow();
        assertApproxEqRel(escrowEth, ethFee * 60 / 100, 0.01e18);
        assertGt(escrowTokens, 0); // the sell paid its fee in the token

        // Split: half to the Parent, half to the creator; token side half burned.
        uint256 childSupplyBefore = IERC20(child).totalSupply();
        splitter.sync();
        assertEq(splitter.parentEth() + splitter.creatorEth(), escrowEth);
        assertApproxEqAbs(splitter.parentEth(), splitter.creatorEth(), 1);
        uint256 burnedChild = escrowTokens * PARENT_SHARE_BPS / 10_000;
        assertEq(IERC20(child).totalSupply(), childSupplyBefore - burnedChild);
        assertEq(IERC20(child).balanceOf(creator), escrowTokens - burnedChild);

        // Buyback through the real v4 pool of the Parent.
        uint256 parentEth = splitter.parentEth();
        uint256 deadBefore = IERC20(neuron).balanceOf(DEAD);
        vm.prank(operator);
        uint256 burned = splitter.buybackParent(parentEth, 1);
        assertGt(burned, 0);
        assertEq(IERC20(neuron).balanceOf(DEAD) - deadBefore, burned);
        assertEq(IERC20(neuron).balanceOf(address(splitter)), 0);
        assertEq(splitter.parentEth(), 0);

        // The creator is paid the rest; nothing is left behind.
        uint256 creatorBefore = creator.balance;
        uint256 owed = splitter.creatorEth();
        splitter.payCreator();
        assertEq(creator.balance - creatorBefore, owed);
        assertEq(address(splitter).balance, 0);
        assertEq(splitter.totalParentEthSpent() + splitter.totalCreatorEthPaid(), escrowEth);
    }

    function test_fork_buybackRespectsSlippageOnRealPool() public onlyFork {
        (address child, NeuronParentSplitter splitter,) = _launchChild(neuron, 0);
        _buy(child, buyer, 1 ether);
        locker.collectFees(child);
        splitter.sync();
        uint256 parentEth = splitter.parentEth();
        vm.prank(operator);
        vm.expectRevert();
        splitter.buybackParent(parentEth, type(uint256).max);
        assertEq(splitter.parentEth(), parentEth);
    }

    function test_fork_hookedExternalParent() public onlyFork {
        // A PONS launch as Parent: its market is a v4 pool with the PONS
        // hook. The key comes straight from the PONS factory's launch record,
        // so this does not depend on the pool's current depth.
        (bool found, PoolKey memory route) = ponsRegistry.referencePool(BLOKKS);
        assertTrue(found, "BLOKKS is a PONS launch");
        assertEq(Currency.unwrap(route.currency0), address(0), "BLOKKS trades against native ETH");
        assertEq(Currency.unwrap(route.currency1), BLOKKS);
        assertEq(address(route.hooks), PONS_HOOK);

        vm.startPrank(owner);
        registry.setHookAllowed(PONS_HOOK, true);
        registry.setParent(BLOKKS, route);
        vm.stopPrank();

        (address child, NeuronParentSplitter splitter,) = _launchChild(BLOKKS, 0);
        _buy(child, buyer, 2 ether);
        locker.collectFees(child);
        splitter.sync();

        uint256 parentEth = splitter.parentEth();
        uint256 deadBefore = IERC20(BLOKKS).balanceOf(DEAD);
        vm.prank(operator);
        uint256 burned = splitter.buybackParent(parentEth, 1);
        assertGt(burned, 0);
        assertEq(IERC20(BLOKKS).balanceOf(DEAD) - deadBefore, burned);
    }

    function test_fork_directLaunchHasNoParent() public onlyFork {
        // Launching on the factory directly still works but is not a
        // Neuron.fun launch: nothing is recorded on the launcher.
        vm.prank(creator);
        (address plain,) = factory.launchToken(_params("PLAIN", "plain"), 0, address(0));
        (address p,,,) = launcher.launches(plain);
        assertEq(p, address(0));
        assertEq(factory.getLaunchedToken(plain).creatorFeeRecipient, creator);
    }
}
