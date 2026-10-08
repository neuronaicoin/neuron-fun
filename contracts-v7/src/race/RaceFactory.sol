// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {LaunchCoin} from "../omni/LaunchCoin.sol";
import {OmniCoinDeployer} from "../omni/OmniDeployers.sol";
import {RaceSeat, IRaceBuilderSeat} from "./RaceSeat.sol";

interface IRaceHubRegister {
    function register(bytes32 coin, address curve, uint32[] calldata eids, uint256 target) external;
}

interface IRaceBuilderLaunch {
    function open(bytes32 coinId, address coin, address seat, uint256 share, uint256 startMarketCap, address creator, uint8 feeMode)
        external;
    function launchBuy(address coin, uint256 usdcAmount, uint256 minCoinsOut, address to) external returns (uint256);
}

/**
 * @title RaceFactory (sasa v7): launches a coin on this chain for the five-minute race
 * @notice Built from the reviewed v6 OmniFactory; the bonding curve is replaced by an
 * instant Uniswap pool. The creator sends the same launch to every chain they picked (one
 * transaction per chain). On each chain, in that one transaction:
 *  1. The coin is deployed with CREATE3 at the address given by (creator, launch key): the
 *     same address on every chain (same v6 coin contract, LayerZero links fixed for good).
 *  2. Its seat is created and registered with this chain's OmniHub (the reviewed v6 hub).
 *  3. The builder becomes the coin's controller and opens the coin's pool with this chain's
 *     share of the supply (1B / chains picked) at the launch price (same on every chain).
 *  4. The creator's first buy on this chain (at least `minFirstBuy`): the pool's first real
 *     trade, so DEX screeners list the coin from the first block.
 * Creators can always sell: there is no creator lock (lock is always 0).
 *
 * The owner (sasa's admin) only sets things for FUTURE launches (launch price, minimum
 * first buy, routes to other chains, open/closed). It has no power over launched coins.
 */
contract RaceFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MAX_CHAINS = 8;
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;
    uint8 public immutable minDvns;

    struct Route {
        address sendLib;
        address receiveLib;
        bytes executorConfig;
        bytes ulnConfig;
    }

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
        uint8 feeMode; // 0 = fees to the creator, 1 = buyback & burn
        uint256 firstBuy; // USDC for the creator's first buy on THIS chain (at least minFirstBuy)
        uint256 minCoinsOut;
    }

    ILayerZeroEndpointV2 public immutable endpoint;
    OmniCoinDeployer public immutable coinDeployer;
    uint32 public immutable localEid;
    IERC20 public immutable usdc;
    address public immutable hub;
    address public immutable builder;
    address public immutable treasury;

    uint256 public startMarketCap; // launch market cap of the whole supply, in USDC units
    uint256 public minFirstBuy; // smallest first buy per chain, in USDC units
    uint16 public moveFeeBps; // fee on the automatic coin move after the race (v6 coin)
    mapping(uint32 eid => Route) internal routes;
    bool public launchesOpen;
    mapping(address seat => bool) public isSeat;

    event Launched(
        bytes32 indexed coinId,
        address indexed coin,
        address indexed seat,
        address creator,
        uint32[] eids,
        string name,
        string symbol,
        string logo,
        string description,
        uint8 feeMode
    );
    event RouteSet(uint32 eid);
    event LaunchesOpenSet(bool open);
    event SettingsSet(uint256 startMarketCap, uint256 minFirstBuy, uint16 moveFeeBps);

    error BadConfig();
    error BadChains();
    error NoRoute(uint32 eid);
    error TooFewVerifiers();
    error LaunchesClosed();
    error FirstBuyTooSmall(uint256 minimum);
    error RenounceDisabled();

    constructor(
        address owner_,
        ILayerZeroEndpointV2 endpoint_,
        uint32 localEid_,
        IERC20 usdc_,
        address hub_,
        address builder_,
        address treasury_,
        uint8 minDvns_,
        OmniCoinDeployer coinDeployer_,
        uint256 startMarketCap_,
        uint256 minFirstBuy_,
        uint16 moveFeeBps_
    ) Ownable(owner_) {
        if (coinDeployer_.factory() != address(this)) revert BadConfig();
        if (minDvns_ == 0) revert BadConfig();
        if (
            address(endpoint_) == address(0) || address(usdc_) == address(0) || hub_ == address(0) || builder_ == address(0)
                || treasury_ == address(0)
        ) revert BadConfig();
        coinDeployer = coinDeployer_;
        minDvns = minDvns_;
        endpoint = endpoint_;
        localEid = localEid_;
        usdc = usdc_;
        hub = hub_;
        builder = builder_;
        treasury = treasury_;
        _setSettings(startMarketCap_, minFirstBuy_, moveFeeBps_);
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

    // ------------------------------------------------------------ launch

    function launch(Launch calldata l) external nonReentrant returns (address coin, address seat) {
        if (!launchesOpen) revert LaunchesClosed();
        uint256 n = l.eids.length;
        if (n == 0 || n > MAX_CHAINS) revert BadChains();
        bool here;
        for (uint256 i; i < n; ++i) {
            if (i > 0 && l.eids[i] <= l.eids[i - 1]) revert BadChains();
            if (l.eids[i] == localEid) here = true;
            else if (routes[l.eids[i]].sendLib == address(0)) revert NoRoute(l.eids[i]);
        }
        if (!here) revert BadChains();
        if (l.firstBuy < minFirstBuy || l.firstBuy == 0) revert FirstBuyTooSmall(minFirstBuy);
        if (l.feeMode > 1) revert BadConfig();

        bytes32 coinId = coinIdOf(msg.sender, l.launchKey);
        // lock 0: creators can always sell
        coin = coinDeployer.deploy(
            coinId, abi.encode(l.name, l.symbol, address(endpoint), moveFeeBps, treasury, msg.sender, uint256(0), address(this))
        );
        _wire(LaunchCoin(coin), l.eids);

        uint256 share = MAX_SUPPLY / n;
        seat = address(
            new RaceSeat(hub, IRaceBuilderSeat(builder), coin, coinId, msg.sender, l.feeMode, startMarketCap, share)
        );
        isSeat[seat] = true;
        LaunchCoin(coin).setController(builder);
        LaunchCoin(coin).renounceOwnership();
        // target 1: every race graduates (the creator's first buy is always in the pool)
        IRaceHubRegister(hub).register(coinId, seat, l.eids, 1);
        IRaceBuilderLaunch(builder).open(coinId, coin, seat, share, startMarketCap, msg.sender, l.feeMode);

        emit Launched(coinId, coin, seat, msg.sender, l.eids, l.name, l.symbol, l.logo, l.description, l.feeMode);

        usdc.safeTransferFrom(msg.sender, builder, l.firstBuy);
        IRaceBuilderLaunch(builder).launchBuy(coin, l.firstBuy, l.minCoinsOut, msg.sender);
    }

    /// @dev Links the coin to its twins and fixes its LayerZero settings for good (as v6).
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

    // ------------------------------------------------------------ admin (future launches only)

    function setRoute(uint32 eid, Route calldata r) external onlyOwner {
        if (eid == localEid || r.sendLib == address(0) || r.receiveLib == address(0)) revert BadConfig();
        UlnConfig memory u = abi.decode(r.ulnConfig, (UlnConfig));
        if (u.requiredDVNCount < minDvns || u.requiredDVNs.length != u.requiredDVNCount) revert TooFewVerifiers();
        routes[eid] = r;
        emit RouteSet(eid);
    }

    function setSettings(uint256 startMarketCap_, uint256 minFirstBuy_, uint16 moveFeeBps_) external onlyOwner {
        _setSettings(startMarketCap_, minFirstBuy_, moveFeeBps_);
    }

    function setLaunchesOpen(bool open) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _setSettings(uint256 startMarketCap_, uint256 minFirstBuy_, uint16 moveFeeBps_) private {
        if (startMarketCap_ == 0 || minFirstBuy_ == 0 || moveFeeBps_ > 50) revert BadConfig();
        startMarketCap = startMarketCap_;
        minFirstBuy = minFirstBuy_;
        moveFeeBps = moveFeeBps_;
        emit SettingsSet(startMarketCap_, minFirstBuy_, moveFeeBps_);
    }
}
