// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {PairPadFeeEscrow} from "../src/v2/PairPadFeeEscrow.sol";
import {PairPadQuotePricer, IUniswapV3FactoryMinimal} from "../src/v2/PairPadQuotePricer.sol";
import {
    PairPadReferenceRegistry,
    PonsReferenceRegistry,
    IPairPadFactoryPoolKeys,
    IPonsV2LaunchFactory
} from "../src/v2/PairPadReferenceRegistries.sol";
import {PairPadLaunchLocker} from "../src/v2/PairPadLaunchLocker.sol";
import {PairPadLaunchFactory} from "../src/v2/PairPadLaunchFactory.sol";
import {PairPadPositionMinter} from "../src/v2/PairPadPositionMinter.sol";
import {PairPadLaunchDeployer} from "../src/v2/PairPadLaunchDeployer.sol";
import {PairPadRouter, ISwapRouter02, IWETH9} from "../src/v2/PairPadRouter.sol";
import {PairPadLauncherToken} from "../src/v2/PairPadLauncherToken.sol";
import {IPairPadFeeEscrow} from "../src/v2/interfaces/ILaunchpadV2.sol";

import {NeuronParentRegistry} from "../src/neuron/NeuronParentRegistry.sol";
import {INeuronSwapRouter} from "../src/neuron/NeuronParentSplitter.sol";
import {NeuronLauncher, INeuronLaunchFactory, INeuronRegistryListing} from "../src/neuron/NeuronLauncher.sol";

import {TestToken, TestnetV3Factory, TestnetSwapRouterStub} from "./DeployTestnetSupport.s.sol";

/**
 * @notice Deploys Neuron.fun in one run: the par core, the Neuron.fun
 * contracts, and $NEURON as the first launch and first Parent.
 *
 * Robinhood Chain mainnet (4663) and testnet (46630) share Uniswap's v4
 * addresses. Testnet has no Uniswap v3, WETH or USDG, so on 46630 the
 * script first deploys par's testnet stand-ins for them (launches against
 * ETH never touch them; the core's constructors just need them to exist).
 *
 *   PRIVATE_KEY=0x... forge script script/DeployNeuron.s.sol --rpc-url <rpc>            # dry run
 *   PRIVATE_KEY=0x... forge script script/DeployNeuron.s.sol --rpc-url <rpc> --broadcast
 *
 * Optional env: OPERATOR (buyback keeper, default deployer),
 * PROTOCOL_FEE_RECIPIENT (default deployer), LAUNCH_FEE (default 0.0005 ETH).
 */
contract DeployNeuron is Script {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant RH_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant RH_SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46630;

    /// @dev Of the 1% base fee: 40% to the protocol, 60% to the creator side.
    uint256 internal constant PROTOCOL_FEE_SHARE_BPS = 4_000;
    /// @dev Of the creator side: half buys and burns the Parent.
    uint16 internal constant PARENT_SHARE_BPS = 5_000;

    struct External {
        address v3Factory;
        address swapRouter02;
        address weth;
        address usdg;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address operator = vm.envOr("OPERATOR", deployer);
        address protocolFeeRecipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", deployer);
        uint256 launchFee = vm.envOr("LAUNCH_FEE", uint256(0.0005 ether));

        require(block.chainid == MAINNET || block.chainid == TESTNET, "unsupported chain");
        require(POOL_MANAGER.code.length > 0, "no Uniswap v4 PoolManager on this chain");
        require(POSITION_MANAGER.code.length > 0, "no Uniswap v4 PositionManager on this chain");
        require(PERMIT2.code.length > 0, "no Permit2 on this chain");

        console2.log("Chain id:                ", block.chainid);
        console2.log("Deployer:                ", deployer);
        console2.log("Deployer balance (wei):  ", deployer.balance);
        require(deployer.balance > launchFee, "deployer balance too low");

        vm.startBroadcast(deployerKey);

        External memory ext = _external();

        // --- par core ---
        PairPadFeeEscrow feeEscrow = new PairPadFeeEscrow();
        PairPadQuotePricer quotePricer = new PairPadQuotePricer(
            deployer, IUniswapV3FactoryMinimal(ext.v3Factory), ext.weth, ext.usdg, IPoolManager(POOL_MANAGER)
        );
        if (block.chainid == MAINNET) {
            quotePricer.setV4HookAllowed(PONS_HOOK, true);
            quotePricer.addRegistry(new PonsReferenceRegistry(IPonsV2LaunchFactory(PONS_FACTORY), IHooks(PONS_HOOK)));
        }
        PairPadLaunchLocker locker = new PairPadLaunchLocker(
            deployer, IPositionManager(POSITION_MANAGER), IPairPadFeeEscrow(address(feeEscrow))
        );
        PairPadLaunchFactory factory = new PairPadLaunchFactory(
            deployer,
            IPoolManager(POOL_MANAGER),
            IPositionManager(POSITION_MANAGER),
            locker,
            IPairPadFeeEscrow(address(feeEscrow)),
            quotePricer,
            protocolFeeRecipient,
            launchFee
        );
        PairPadPositionMinter minter = new PairPadPositionMinter(
            IPositionManager(POSITION_MANAGER), IAllowanceTransfer(PERMIT2), locker, address(factory)
        );
        PairPadLaunchDeployer launchDeployer = new PairPadLaunchDeployer(address(factory));
        PairPadRouter router = new PairPadRouter(
            IPoolManager(POOL_MANAGER), factory, ISwapRouter02(ext.swapRouter02), IWETH9(ext.weth)
        );

        quotePricer.addRegistry(new PairPadReferenceRegistry(IPairPadFactoryPoolKeys(address(factory))));
        locker.setFactory(address(factory));
        factory.setPositionMinter(minter);
        factory.setLaunchDeployer(launchDeployer);
        factory.addLaunchConfig(
            PairPadLaunchFactory.LaunchConfig({
                supply: 1_000_000_000 ether, phantomQuote: 1.3557 ether, tickSpacing: 10, enabled: true
            })
        );
        factory.setProtocolFeeShareBps(PROTOCOL_FEE_SHARE_BPS);

        // --- Neuron.fun ---
        NeuronParentRegistry registry = new NeuronParentRegistry(deployer, operator);
        NeuronLauncher launcher = new NeuronLauncher(
            deployer,
            INeuronLaunchFactory(address(factory)),
            INeuronSwapRouter(address(router)),
            INeuronRegistryListing(address(registry)),
            IPairPadFeeEscrow(address(feeEscrow)),
            PARENT_SHARE_BPS
        );
        factory.setLaunchForwarder(address(launcher));
        factory.setLaunchEnabled(true);

        // --- $NEURON: first launch, first Parent ---
        (address neuron,) = factory.launchToken{value: launchFee}(_neuronParams(), 0, address(0));
        PoolKey memory neuronRoute = factory.poolKeyFor(neuron);
        registry.setParent(neuron, neuronRoute);

        vm.stopBroadcast();

        console2.log("--- par core ---");
        console2.log("PairPadFeeEscrow:        ", address(feeEscrow));
        console2.log("PairPadQuotePricer:      ", address(quotePricer));
        console2.log("PairPadLaunchLocker:     ", address(locker));
        console2.log("PairPadLaunchFactory:    ", address(factory));
        console2.log("PairPadPositionMinter:   ", address(minter));
        console2.log("PairPadLaunchDeployer:   ", address(launchDeployer));
        console2.log("PairPadRouter:           ", address(router));
        console2.log("--- Neuron.fun ---");
        console2.log("NeuronParentRegistry:    ", address(registry));
        console2.log("NeuronLauncher:          ", address(launcher));
        console2.log("Operator:                ", operator);
        console2.log("$NEURON:                 ", neuron);
        console2.log("Deployer balance after:  ", deployer.balance);
    }

    function _external() internal returns (External memory ext) {
        if (block.chainid == MAINNET) {
            return External({v3Factory: RH_V3_FACTORY, swapRouter02: RH_SWAP_ROUTER_02, weth: RH_WETH, usdg: RH_USDG});
        }
        // Testnet: par's stand-ins. Nothing in an ETH-quoted launch uses them.
        TestToken weth = new TestToken("Test Wrapped Ether", "WETH", 18);
        TestToken usdg = new TestToken("Test Global Dollar", "USDG", 6);
        TestnetV3Factory v3Factory = new TestnetV3Factory(address(weth));
        TestnetSwapRouterStub routerStub = new TestnetSwapRouterStub();
        console2.log("Test WETH:               ", address(weth));
        console2.log("Test USDG:               ", address(usdg));
        return External({
            v3Factory: address(v3Factory), swapRouter02: address(routerStub), weth: address(weth), usdg: address(usdg)
        });
    }

    function _neuronParams() internal pure returns (PairPadLaunchFactory.TokenParams memory) {
        return PairPadLaunchFactory.TokenParams({
            name: "Neuron",
            symbol: "NEURON",
            logo: "",
            description: "The Neuron.fun platform token. Platform fees buy it back and burn it.",
            socials: PairPadLauncherToken.Socials("https://x.com/neuronaicoin", "", "", "https://neuronaicoin.com", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            expectedEconomics: bytes32(0),
            salt: bytes32("neuron")
        });
    }
}
