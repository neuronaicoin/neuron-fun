// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MessagingParams, MessagingFee, MessagingReceipt, Origin} from
    "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

interface IComposer {
    function lzCompose(address from, bytes32 guid, bytes calldata message, address executor, bytes calldata extra) external payable;
}

interface IReceiver {
    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata m, address ex, bytes calldata extra) external payable;
}

/// @dev Minimal stand-in for the LayerZero endpoint: records sent packets and lets a
/// test deliver them to the receiving OApp (as the real executor would).
contract MockLzEndpoint {
    struct Packet {
        uint32 srcEid;
        address sender;
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
    }

    uint32 public immutable eid;
    uint256 public fee;
    Packet[] public packets;
    mapping(address => address) public delegates;
    uint64 public nonce;

    constructor(uint32 eid_) {
        eid = eid_;
    }

    function setFee(uint256 f) external {
        fee = f;
    }

    function setDelegate(address d) external {
        delegates[msg.sender] = d;
    }

    // Settings an OApp's delegate fixes at launch (recorded so tests can check them).
    mapping(address oapp => mapping(uint32 eid => address)) public sendLib;
    mapping(address oapp => mapping(uint32 eid => address)) public receiveLib;
    mapping(address oapp => uint256) public configCalls;

    function setSendLibrary(address oapp, uint32 dst, address lib) external {
        require(delegates[oapp] == msg.sender || oapp == msg.sender, "not delegate");
        sendLib[oapp][dst] = lib;
    }

    function setReceiveLibrary(address oapp, uint32 dst, address lib, uint256) external {
        require(delegates[oapp] == msg.sender || oapp == msg.sender, "not delegate");
        receiveLib[oapp][dst] = lib;
    }

    struct Param {
        uint32 eid;
        uint32 configType;
        bytes config;
    }

    function setConfig(address oapp, address, Param[] calldata) external {
        require(delegates[oapp] == msg.sender || oapp == msg.sender, "not delegate");
        configCalls[oapp] += 1;
    }

    function lzToken() external pure returns (address) {
        return address(0);
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(fee, 0);
    }

    function send(MessagingParams calldata p, address) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= fee, "fee");
        packets.push(Packet(eid, msg.sender, p.dstEid, p.receiver, p.message));
        r.guid = keccak256(abi.encode(eid, msg.sender, packets.length));
        r.nonce = ++nonce;
        r.fee = MessagingFee(msg.value, 0);
    }

    struct Compose {
        address from;
        address to;
        bytes32 guid;
        bytes message;
    }

    Compose[] public composes;

    function sendCompose(address to, bytes32 guid, uint16, bytes calldata message) external {
        composes.push(Compose(msg.sender, to, guid, message));
    }

    function composeCount() external view returns (uint256) {
        return composes.length;
    }

    /// @dev Runs the last queued compose call (as the executor would).
    function deliverLastCompose() external {
        Compose memory c = composes[composes.length - 1];
        IComposer(c.to).lzCompose(c.from, c.guid, c.message, address(this), "");
    }

    function packetCount() external view returns (uint256) {
        return packets.length;
    }

    function packetAt(uint256 i) external view returns (Packet memory) {
        return packets[i];
    }

    /// @dev Called on the DESTINATION endpoint with a packet taken from the source endpoint.
    function deliver(Packet memory p) external {
        address to = address(uint160(uint256(p.receiver)));
        IReceiver(to).lzReceive(
            Origin(p.srcEid, bytes32(uint256(uint160(p.sender))), 1), bytes32(0), p.message, address(this), ""
        );
    }
}
