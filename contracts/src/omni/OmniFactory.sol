// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {LaunchCoin} from "./LaunchCoin.sol";
import {UsdCurveV6} from "./UsdCurveV6.sol";
import {OmniCoinDeployer, OmniCurveDeployer} from "./OmniDeployers.sol";

interface IOmniHubRegister {
    function register(bytes32 coin, address curve, uint32[] calldata eids, uint256 target) external;
}

/**
 * @title OmniFactory (v6)
 * @notice Launches an omnichain coin on this chain. The creator sends the same launch to
 * every chain they picked (one transaction per chain, as today). On each chain, in
 * that one transaction:
 *  1. The coin is deployed with CREATE3 at the address given by (creator, launch key):
 *     the same address on every chain, because this factory has the same address
 *     everywhere (deployed by the same key at the same nonce).
 *  2. Its LayerZero links to the coin on the other picked chains are set, with the
 *     send/receive libraries and verifier (DVN) settings fixed here; then the coin's
 *     endpoint delegate is sent to a dead address and its ownership renounced, so
 *     nobody can ever change them.
 *  3. Its curve is created, scaled to 1/N of the reference curve (N = chains picked),
 *     and registered with this chain's OmniHub under the coin's id.
 *  4. Optionally the creator buys first.
 *
  * The coin and curve bytecode live in two helper contracts (OmniDeployers) so this
 * contract stays under the 24 KB limit.
 *
 * The owner (sasa's Safe) only sets things for FUTURE launches (curve settings, routes
 * to other chains) and the v5 beta locks (pause buys, total cap). It has no power over
 * coins already launched.
 */
contract OmniFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;
    /// @notice Verifiers every route must require. 2+ on mainnet; a testnet may only have
    /// LayerZero's own verifier, so its factory is deployed with 1. Fixed at deployment.
    uint8 public immutable minDvns;

    struct Config {
        uint256 virtualNative; // reference curve (all chains together), USDC
        uint256 virtualToken;
        uint256 target; // graduation target over all chains, USDC
        uint16 feeBps;
        uint16 creatorShareBps;
        uint16 moveFeeBps;
    }

    /// @notice How coins on this chain talk to coins on another chain. Fixed into each coin at launch.
    struct Route {
        address sendLib;
        address receiveLib;
        bytes executorConfig; // abi.encode(ExecutorConfig)
        bytes ulnConfig; // abi.encode(UlnConfig): verifiers and confirmations
    }

    /// @dev Same layout as LayerZero's UlnConfig; used to check the verifier count.
    struct UlnConfig {
        uint64 confirmations;
        uint8 requiredDVNCount;
        uint8 optionalDVNCount;
        uint8 optionalDVNThreshold;
        address[] requiredDVNs;
        address[] optionalDVNs;
    }

    struct Launch {
        string name;
        string symbol;
        string logo;
        string description;
        bytes32 launchKey;
        uint32[] eids; // every chain picked, sorted
        uint256 lockSeconds;
        UsdCurveV6.FeeMode feeMode;
        uint256 devBuy; // USDC to spend on the creator's first buy (0: none)
        uint256 minDevTokens;
    }

    ILayerZeroEndpointV2 public immutable endpoint;
    OmniCoinDeployer public immutable coinDeployer;
    OmniCurveDeployer public immutable curveDeployer;
    uint32 public immutable localEid;
    IERC20 public immutable usdc;

    address public hub;
    address public migrator;
    address public consolidator;
    address public treasury;
    address public protocolFeeRecipient;
    Config public config;
    mapping(uint32 eid => Route) internal routes;
    bool public launchesOpen;

    // v5 beta locks
    mapping(address curve => bool) public isCurve;
    address public guardian;
    bool public buysPaused;
    uint256 public nativeCap;
    uint256 public totalNative;

    event Launched(
        bytes32 indexed coinId,
        address indexed coin,
        address indexed curve,
        address creator,
        uint32[] eids,
        string name,
        string symbol,
        string logo,
        string description,
        uint256 lockSeconds,
        UsdCurveV6.FeeMode feeMode
    );
    event RouteSet(uint32 eid);
    event GuardianSet(address guardian);
    event NativeCapSet(uint256 cap);
    event LaunchesOpenSet(bool open);
    event ConfigSet(Config config);
    event BuysPausedSet(bool paused, address by);

    error BadConfig();
    error BadChains();
    error NoRoute(uint32 eid);
    error TooFewVerifiers();
    error LaunchesClosed();
    error NotCurve();
    error NotGuardian();
    error CapReached(uint256 total, uint256 cap);
    error RenounceDisabled();

    constructor(
        address owner_,
        ILayerZeroEndpointV2 endpoint_,
        uint32 localEid_,
        IERC20 usdc_,
        address hub_,
        address migrator_,
        address consolidator_,
        address treasury_,
        address protocolFeeRecipient_,
        Config memory config_,
        uint8 minDvns_,
        OmniCoinDeployer coinDeployer_,
        OmniCurveDeployer curveDeployer_
    ) Ownable(owner_) {
        if (coinDeployer_.factory() != address(this) || curveDeployer_.factory() != address(this)) revert BadConfig();
        coinDeployer = coinDeployer_;
        curveDeployer = curveDeployer_;
        if (minDvns_ == 0) revert BadConfig();
        minDvns = minDvns_;
        if (
            address(endpoint_) == address(0) || address(usdc_) == address(0) || hub_ == address(0) || migrator_ == address(0)
                || consolidator_ == address(0) || treasury_ == address(0) || protocolFeeRecipient_ == address(0)
        ) revert BadConfig();
        endpoint = endpoint_;
        localEid = localEid_;
        usdc = usdc_;
        hub = hub_;
        migrator = migrator_;
        consolidator = consolidator_;
        treasury = treasury_;
        protocolFeeRecipient = protocolFeeRecipient_;
        _setConfig(config_);
    }

    // ------------------------------------------------------------ views

    function coinIdOf(address creator, bytes32 launchKey) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, launchKey));
    }

    /// @notice The coin's address, the same on every chain.
    function coinAddress(address creator, bytes32 launchKey) public view returns (address) {
        return coinDeployer.predict(coinIdOf(creator, launchKey));
    }

    function routeOf(uint32 eid) external view returns (Route memory) {
        return routes[eid];
    }

    /// @notice Coins one chain may sell: what it would sell if 120% of the target landed on it.
    function saleCapFor(uint256 n) public view returns (uint256) {
        uint256 v = config.virtualNative / n;
        uint256 t = config.virtualToken / n;
        uint256 r = (config.target * 12) / 10;
        return t - (v * t) / (v + r);
    }

    // ------------------------------------------------------------ launch

    function launch(Launch calldata l) external nonReentrant returns (address coin, address curve) {
        if (!launchesOpen) revert LaunchesClosed();
        uint256 n = l.eids.length;
        if (n == 0 || n > 8) revert BadChains();
        bool here;
        for (uint256 i; i < n; ++i) {
            if (i > 0 && l.eids[i] <= l.eids[i - 1]) revert BadChains();
            if (l.eids[i] == localEid) here = true;
            else if (routes[l.eids[i]].sendLib == address(0)) revert NoRoute(l.eids[i]);
        }
        if (!here) revert BadChains();

        bytes32 coinId = coinIdOf(msg.sender, l.launchKey);
        coin = coinDeployer.deploy(
            coinId,
            abi.encode(l.name, l.symbol, address(endpoint), config.moveFeeBps, treasury, msg.sender, l.lockSeconds, address(this))
        );
        _wire(LaunchCoin(coin), l.eids);

        curve = curveDeployer.deploy(
                UsdCurveV6.Params({
                    quote: usdc,
                    coin: LaunchCoin(coin),
                    coinId: coinId,
                    factory: address(this),
                    hub: hub,
                    migrator: migrator,
                    consolidator: consolidator,
                    creator: msg.sender,
                    protocolFeeRecipient: protocolFeeRecipient,
                    virtualNative: config.virtualNative / n,
                    virtualToken: config.virtualToken / n,
                    saleCap: saleCapFor(n),
                    feeBps: config.feeBps,
                    creatorShareBps: config.creatorShareBps,
                    feeMode: l.feeMode
                })
        );
        isCurve[curve] = true;
        LaunchCoin(coin).setController(curve);
        LaunchCoin(coin).renounceOwnership();
        IOmniHubRegister(hub).register(coinId, curve, l.eids, config.target);

        emit Launched(coinId, coin, curve, msg.sender, l.eids, l.name, l.symbol, l.logo, l.description, l.lockSeconds, l.feeMode);

        if (l.devBuy > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), l.devBuy);
            usdc.forceApprove(curve, l.devBuy);
            UsdCurveV6(curve).buy(l.devBuy, l.minDevTokens, msg.sender);
            usdc.forceApprove(curve, 0);
            uint256 left = usdc.balanceOf(address(this));
            if (left > 0) usdc.safeTransfer(msg.sender, left); // the cap may leave some unspent
        }
    }

    /// @dev Links the coin to its twins and fixes its LayerZero settings for good.
    function _wire(LaunchCoin coin, uint32[] calldata eids) internal {
        bytes32 me = bytes32(uint256(uint160(address(coin))));
        for (uint256 i; i < eids.length; ++i) {
            uint32 eid = eids[i];
            if (eid == localEid) continue;
            Route storage r = routes[eid];
            coin.setPeer(eid, me);
            endpoint.setSendLibrary(address(coin), eid, r.sendLib);
            endpoint.setReceiveLibrary(address(coin), eid, r.receiveLib, 0);
            SetConfigParam[] memory send = new SetConfigParam[](2);
            send[0] = SetConfigParam(eid, CONFIG_TYPE_EXECUTOR, r.executorConfig);
            send[1] = SetConfigParam(eid, CONFIG_TYPE_ULN, r.ulnConfig);
            endpoint.setConfig(address(coin), r.sendLib, send);
            SetConfigParam[] memory recv = new SetConfigParam[](1);
            recv[0] = SetConfigParam(eid, CONFIG_TYPE_ULN, r.ulnConfig);
            endpoint.setConfig(address(coin), r.receiveLib, recv);
        }
        coin.setDelegate(DEAD);
    }

    // ------------------------------------------------------------ curve hooks (v5 beta locks)

    function noteNativeIn(uint256 amount, bool enforceCap) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        uint256 total = totalNative + amount;
        if (enforceCap && nativeCap != 0 && total > nativeCap) revert CapReached(total, nativeCap);
        totalNative = total;
    }

    function noteNativeOut(uint256 amount) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        totalNative = amount >= totalNative ? 0 : totalNative - amount;
    }

    function pauseBuys() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        buysPaused = true;
        emit BuysPausedSet(true, msg.sender);
    }

    function unpauseBuys() external onlyOwner {
        buysPaused = false;
        emit BuysPausedSet(false, msg.sender);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function setNativeCap(uint256 cap) external onlyOwner {
        nativeCap = cap;
        emit NativeCapSet(cap);
    }

    // ------------------------------------------------------------ admin (future launches only)

    /// @notice Route to another chain, used by coins launched from now on. At least `minDvns` required verifiers.
    function setRoute(uint32 eid, Route calldata r) external onlyOwner {
        if (eid == localEid || r.sendLib == address(0) || r.receiveLib == address(0)) revert BadConfig();
        UlnConfig memory u = abi.decode(r.ulnConfig, (UlnConfig));
        if (u.requiredDVNCount < minDvns || u.requiredDVNs.length != u.requiredDVNCount) revert TooFewVerifiers();
        routes[eid] = r;
        emit RouteSet(eid);
    }

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setLaunchesOpen(bool open) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _setConfig(Config memory c) private {
        if (
            c.virtualNative == 0 || c.virtualToken == 0 || c.target == 0 || c.feeBps > 1_000 || c.creatorShareBps > 10_000
                || c.moveFeeBps > 50
        ) revert BadConfig();
        // The single-chain sale cap must leave room for the pool coins under 1B.
        config = c;
        uint256 sold1 = saleCapFor(1);
        uint256 r = (c.target * 12) / 10;
        uint256 pool1 = (r * c.virtualToken / (c.virtualNative + r)) * c.virtualNative / (c.virtualNative + r);
        if (sold1 + pool1 > 1_000_000_000 ether || c.virtualToken <= sold1) revert BadConfig();
        emit ConfigSet(c);
    }
}
