// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NeuronCurve, IGraduationMigrator} from "./NeuronCurve.sol";

/**
 * @title NeuronCurveFactory
 * @notice Creates coins on this chain. A coin launched on several chains is
 * created once per chain with the same `launchKey`; the keeper groups curves
 * by (creator, launchKey) across chains.
 *
 * The owner sets terms for future launches only. Every curve freezes its
 * terms, fee recipient and migrator when it is created.
 */
contract NeuronCurveFactory is Ownable2Step, ReentrancyGuard {
    struct Config {
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 tokensForSale;
        uint256 graduationTokens;
        uint16 feeBps;
        uint16 creatorShareBps;
        uint256 minGraduationNative;
    }

    IGraduationMigrator public immutable migrator;
    Config public config;
    address public operator;
    address public protocolFeeRecipient;
    bool public launchesOpen;

    mapping(address curve => bool) public isCurve;
    address[] public allCurves;

    event Launched(
        address indexed curve,
        address indexed token,
        address indexed creator,
        bytes32 launchKey,
        string name,
        string symbol
    );
    event ConfigSet(Config config);
    event OperatorSet(address operator);
    event ProtocolFeeRecipientSet(address recipient);
    event LaunchesOpenSet(bool open);

    error ZeroAddress();
    error LaunchesClosed();
    error BadConfig();
    error RenounceDisabled();

    constructor(
        address owner_,
        IGraduationMigrator migrator_,
        address operator_,
        address protocolFeeRecipient_,
        Config memory config_
    ) Ownable(owner_) {
        if (address(migrator_) == address(0) || operator_ == address(0) || protocolFeeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        migrator = migrator_;
        operator = operator_;
        protocolFeeRecipient = protocolFeeRecipient_;
        _setConfig(config_);
        emit OperatorSet(operator_);
        emit ProtocolFeeRecipientSet(protocolFeeRecipient_);
    }

    /**
     * @notice Creates a coin and its curve. Anything sent with the call is
     * the creator's first buy, at the same price as everyone else.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address curve, address token, uint256 tokensBought) {
        if (!launchesOpen) revert LaunchesClosed();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert BadConfig();
        NeuronCurve created = new NeuronCurve(_params(name, symbol, logo, description, launchKey));
        curve = address(created);
        token = address(created.token());
        isCurve[curve] = true;
        allCurves.push(curve);
        emit Launched(curve, token, msg.sender, launchKey, name, symbol);

        if (msg.value > 0) {
            tokensBought = created.buy{value: msg.value}(minTokensOut, msg.sender);
            // A sell-out refund comes back here; pass it on.
            uint256 left = address(this).balance;
            if (left > 0) {
                (bool ok,) = payable(msg.sender).call{value: left}("");
                require(ok, "refund failed");
            }
        }
    }

    function _params(
        string calldata name,
        string calldata symbol,
        string calldata logo,
        string calldata description,
        bytes32 launchKey
    ) private view returns (NeuronCurve.Params memory p) {
        Config memory c = config;
        p.name = name;
        p.symbol = symbol;
        p.logo = logo;
        p.description = description;
        p.creator = msg.sender;
        p.protocolFeeRecipient = protocolFeeRecipient;
        p.migrator = migrator;
        p.launchKey = launchKey;
        p.virtualNative = c.virtualNative;
        p.virtualToken = c.virtualToken;
        p.tokensForSale = c.tokensForSale;
        p.graduationTokens = c.graduationTokens;
        p.feeBps = c.feeBps;
        p.creatorShareBps = c.creatorShareBps;
        p.minGraduationNative = c.minGraduationNative;
    }

    function curveCount() external view returns (uint256) {
        return allCurves.length;
    }

    // ------------------------------------------------------------ admin

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setOperator(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        operator = o;
        emit OperatorSet(o);
    }

    function setProtocolFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        protocolFeeRecipient = r;
        emit ProtocolFeeRecipientSet(r);
    }

    function setLaunchesOpen(bool open) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev Only the refund of a sell-out first buy is ever sent here.
    receive() external payable {
        require(isCurve[msg.sender], "not a curve");
    }

    function _setConfig(Config memory c) private {
        if (
            c.virtualNative == 0 || c.tokensForSale == 0 || c.virtualToken <= c.tokensForSale || c.feeBps > 1_000
                || c.creatorShareBps > 10_000
        ) revert BadConfig();
        config = c;
        emit ConfigSet(c);
    }
}
