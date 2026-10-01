// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MessagingParams, MessagingFee, MessagingReceipt, Origin} from
    "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

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

    function setSendLibrary(address oapp, uint32 eid, address lib) external {
        require(delegates[oapp] == msg.sender || oapp == msg.sender, "not delegate");
        sendLib[oapp][eid] = lib;
    }

    function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256) external {
        require(delegates[oapp] == msg.sender || oapp == msg.sender, "not delegate");
        receiveLib[oapp][eid] = lib;
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
