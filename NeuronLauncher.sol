// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PairPadLaunchFactory} from "../v2/PairPadLaunchFactory.sol";
import {IPairPadFeeEscrow} from "../v2/interfaces/ILaunchpadV2.sol";
import {NeuronParentSplitter, INeuronSwapRouter, INeuronParentRegistry} from "./NeuronParentSplitter.sol";

interface INeuronLaunchFactory {
    function launchFee() external view returns (uint256);
    function poolKeyFor(address token) external view returns (PoolKey memory);
    function launchTokenFor(
        PairPadLaunchFactory.TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address originalDeployer
    ) external payable returns (address token, PoolId poolId);
}

interface INeuronRegistryListing is INeuronParentRegistry {
    function isListed(address parent) external view returns (bool);
}

/**
 * @title NeuronLauncher
 * @notice Entry point for Neuron.fun launches. Every launch through it
 * names a listed Parent. In one transaction it:
 *
 * 1. deploys a NeuronParentSplitter for the launch,
 * 2. launches the token on the factory against native ETH, with the
 *    splitter as the creator fee recipient and the caller as the deployer,
 * 3. binds the new token to the splitter,
 * 4. optionally spends the rest of `msg.value` as the first buy, delivered
 *    to the caller.
 *
 * The factory must name this contract as its `launchForwarder`. Tokens
 * launched on the factory directly have no Parent and are not Neuron.fun
 * launches; the interface lists only launches recorded here.
 */
contract NeuronLauncher is Ownable2Step, ReentrancyGuard {
    uint256 public constant LAUNCH_CONFIG_ID = 0;
    uint16 public constant MAX_PARENT_SHARE_BPS = 10_000;

    INeuronLaunchFactory public immutable factory;
    INeuronSwapRouter public immutable router;
    INeuronRegistryListing public immutable registry;
    IPairPadFeeEscrow public immutable escrow;

    /// @notice Share of the creator fee that goes to the Parent, for launches
    /// made from now on. Frozen into each launch's splitter.
    uint16 public parentShareBps;

    struct Launch {
        address parent;
        address splitter;
        address creator;
        uint64 launchedAt;
    }

    mapping(address token => Launch) public launches;
    uint256 public launchCount;

    event NeuronLaunch(
        address indexed token,
        address indexed parent,
        address indexed creator,
        address splitter,
        uint16 parentShareBps,
        uint256 devBuyEth,
        uint256 devBuyTokens
    );
    event ParentShareSet(uint16 previousBps, uint16 newBps);

    error ZeroAddress();
    error ParentNotListed(address parent);
    error LaunchFeeNotCovered(uint256 sent, uint256 fee);
    error InvalidBps();
    error RenounceDisabled();

    constructor(
        address owner_,
        INeuronLaunchFactory factory_,
        INeuronSwapRouter router_,
        INeuronRegistryListing registry_,
        IPairPadFeeEscrow escrow_,
        uint16 parentShareBps_
    ) Ownable(owner_) {
        if (
            address(factory_) == address(0) || address(router_) == address(0) || address(registry_) == address(0)
                || address(escrow_) == address(0)
        ) revert ZeroAddress();
        if (parentShareBps_ > MAX_PARENT_SHARE_BPS) revert InvalidBps();
        factory = factory_;
        router = router_;
        registry = registry_;
        escrow = escrow_;
        parentShareBps = parentShareBps_;
        emit ParentShareSet(0, parentShareBps_);
    }

    /**
     * @notice Launches a token under `parent`. `msg.value` must cover the
     * factory's launch fee; anything above it is the first buy.
     * @param params Token metadata. `creatorFeeRecipient` is ignored: the
     * launch's splitter always receives the creator fee.
     * @param minTokensOut Slippage floor for the first buy (ignored without one).
     */
    function launch(PairPadLaunchFactory.TokenParams calldata params, address parent, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (address token, address splitter, uint256 devBuyTokens)
    {
        if (!registry.isListed(parent)) revert ParentNotListed(parent);
        uint256 fee = factory.launchFee();
        if (msg.value < fee) revert LaunchFeeNotCovered(msg.value, fee);
        uint16 bps = parentShareBps;

        splitter = address(
            new NeuronParentSplitter(escrow, router, registry, parent, msg.sender, bps)
        );

        PairPadLaunchFactory.TokenParams memory p = params;
        p.creatorFeeRecipient = splitter;
        (token,) = factory.launchTokenFor{value: fee}(p, LAUNCH_CONFIG_ID, address(0), msg.sender);

        NeuronParentSplitter(payable(splitter)).bindChild(token);
        launches[token] =
            Launch({parent: parent, splitter: splitter, creator: msg.sender, launchedAt: uint64(block.timestamp)});
        launchCount += 1;

        uint256 devBuy = msg.value - fee;
        if (devBuy > 0) {
            PoolKey memory key = factory.poolKeyFor(token);
            // A native-ETH pool always has ETH as currency0, so buying the
            // launch token is zeroForOne.
            devBuyTokens = router.swapExactIn{value: devBuy}(key, true, devBuy, minTokensOut, msg.sender);
        }

        emit NeuronLaunch(token, parent, msg.sender, splitter, bps, devBuy, devBuyTokens);
    }

    function setParentShareBps(uint16 bps) external onlyOwner {
        if (bps > MAX_PARENT_SHARE_BPS) revert InvalidBps();
        emit ParentShareSet(parentShareBps, bps);
        parentShareBps = bps;
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
