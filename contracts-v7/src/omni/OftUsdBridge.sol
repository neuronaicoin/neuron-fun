// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOFT, SendParam} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import {OFTComposeMsgCodec} from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {IUsdcBridge} from "./ConsolidatorV6.sol";

interface IMigratorReceive {
    function receiveConsolidated(bytes32 coin, uint256 amount, bool buyback) external;
}

/**
 * @title OftUsdBridge
 * @notice USDC route for v6 when the dollar is a LayerZero OFT (testnet: TestUsdOft;
 * mainnet: any chain pair whose dollar is an OFT, e.g. USDG). One per chain.
 *
 * Sending side: takes the money from this chain's consolidator and sends it with
 * the OFT to the bridge on the winning chain, tagged with the coin.
 * Receiving side: LayerZero hands the money and the tag to `lzCompose`; the bridge
 * passes the money to the local migrator and tells it which coin it is for.
 *
 * Only the consolidator may send. Arrivals are accepted only from this bridge's twin
 * on another chain, through the OFT, via the LayerZero endpoint. The migrator and the
 * twins are set once (owner), then fixed.
 */
contract OftUsdBridge is IUsdcBridge, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;

    IOFT public immutable oft;
    IERC20 public immutable token;
    address public immutable endpoint;
    uint128 public constant RECEIVE_GAS = 80_000;
    uint128 public constant COMPOSE_GAS = 300_000;

    address public consolidator;
    address public migrator;
    mapping(uint32 eid => bytes32) public twins;
    bool public locked;

    event Sent(uint32 indexed dstEid, bytes32 indexed coin, uint256 amount, bool buyback);
    event Delivered(uint32 indexed srcEid, bytes32 indexed coin, uint256 amount, bool buyback);

    error NotConsolidator();
    error NotEndpoint();
    error WrongOft();
    error UnknownTwin();
    error Locked();
    error BadAddress();

    constructor(IOFT oft_, address endpoint_, address owner_) Ownable(owner_) {
        oft = oft_;
        token = IERC20(oft_.token());
        endpoint = endpoint_;
    }

    // ------------------------------------------------------------ setup (once)

    function setup(address consolidator_, address migrator_, uint32[] calldata eids, bytes32[] calldata twins_)
        external
        onlyOwner
    {
        if (locked) revert Locked();
        if (consolidator_ == address(0) || migrator_ == address(0) || eids.length != twins_.length) revert BadAddress();
        consolidator = consolidator_;
        migrator = migrator_;
        for (uint256 i; i < eids.length; ++i) twins[eids[i]] = twins_[i];
    }

    /// @notice After this nothing can be changed (new chains get a new bridge).
    function lock() external onlyOwner {
        locked = true;
    }

    // ------------------------------------------------------------ send

    function _param(uint32 dstEid, bytes32 coin, uint256 amount, bool buyback) internal view returns (SendParam memory p) {
        bytes32 to = twins[dstEid];
        if (to == bytes32(0)) revert UnknownTwin();
        bytes memory options =
            OptionsBuilder.newOptions().addExecutorLzReceiveOption(RECEIVE_GAS, 0).addExecutorLzComposeOption(0, COMPOSE_GAS, 0);
        // A 6-decimal dollar OFT drops nothing in transit, so the full amount must arrive.
        p = SendParam(dstEid, to, amount, amount, options, abi.encode(coin, buyback), "");
    }

    function quote(uint32 dstEid, uint256 amount) external view returns (uint256 nativeFee) {
        SendParam memory p = _param(dstEid, bytes32(0), amount, false);
        nativeFee = oft.quoteSend(p, false).nativeFee;
    }

    function send(uint32 dstEid, bytes32 coin, uint256 amount, bool buyback, address refund)
        external
        payable
        nonReentrant
    {
        if (msg.sender != consolidator) revert NotConsolidator();
        token.safeTransferFrom(msg.sender, address(this), amount);
        SendParam memory p = _param(dstEid, coin, amount, buyback);
        token.forceApprove(address(oft), amount);
        oft.send{value: msg.value}(p, MessagingFee(msg.value, 0), refund);
        token.forceApprove(address(oft), 0);
        emit Sent(dstEid, coin, amount, buyback);
    }

    // ------------------------------------------------------------ receive

    /// @notice Called by the LayerZero endpoint after the OFT delivered money here.
    function lzCompose(address from, bytes32, bytes calldata message, address, bytes calldata) external payable nonReentrant {
        if (msg.sender != endpoint) revert NotEndpoint();
        if (from != address(oft)) revert WrongOft();
        uint32 src = OFTComposeMsgCodec.srcEid(message);
        if (twins[src] == bytes32(0) || OFTComposeMsgCodec.composeFrom(message) != twins[src]) revert UnknownTwin();
        uint256 amount = OFTComposeMsgCodec.amountLD(message);
        (bytes32 coin, bool buyback) = abi.decode(OFTComposeMsgCodec.composeMsg(message), (bytes32, bool));
        token.safeTransfer(migrator, amount);
        IMigratorReceive(migrator).receiveConsolidated(coin, amount, buyback);
        emit Delivered(src, coin, amount, buyback);
    }
}
