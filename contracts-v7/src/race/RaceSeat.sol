// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRaceBuilderSeat {
    function report(address coin) external returns (uint256 money, uint256 coinsOutside);
    function settle(address coin, uint32 winnerEid, bool isWinner) external returns (uint256 handedOver);
    function consolidator() external view returns (address);
}

interface IConsolidatorIn {
    function fromCurve(bytes32 coin, uint256 money) external;
}

/**
 * @title RaceSeat (sasa v7): a coin's handle for the cross-chain hub on this chain
 * @notice The reviewed v6 hub (OmniHub) talks to one contract per coin per chain through
 * the v6 "curve" interface: freeze → report the money, settle → apply the verdict. In v7
 * there is no curve; this small contract speaks that interface and forwards to the
 * RaceBuilder that holds the coin's pool. It holds no funds.
 * - freeze: only once the five-minute race is over; trading never stops (the money in the
 *   pool at that moment is the race result for this chain).
 * - reopen: never needed (every race graduates: the target is the smallest amount), kept
 *   as a no-op so the hub's interface is complete.
 * - settle: the losing chain's builder empties the pool and sends the dollars to the
 *   consolidator; this seat then registers them there (the consolidator only accepts
 *   them from the coin's registered contract, which is this seat).
 */
contract RaceSeat {
    address public immutable hub;
    IRaceBuilderSeat public immutable builder;
    address public immutable coin;
    bytes32 public immutable coinId;
    address public immutable creator;
    uint8 public immutable feeMode;
    uint256 public immutable startMarketCap; // same on every chain of the coin
    uint256 public immutable chainShare; // same on every chain of the coin

    uint32 public winnerEid;
    bool public reported;

    error NotHub();

    constructor(
        address hub_,
        IRaceBuilderSeat builder_,
        address coin_,
        bytes32 coinId_,
        address creator_,
        uint8 feeMode_,
        uint256 startMarketCap_,
        uint256 chainShare_
    ) {
        hub = hub_;
        builder = builder_;
        coin = coin_;
        coinId = coinId_;
        creator = creator_;
        feeMode = feeMode_;
        startMarketCap = startMarketCap_;
        chainShare = chainShare_;
    }

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    function freeze() external onlyHub returns (uint256 money, uint256 coinsSold) {
        (money, coinsSold) = builder.report(coin);
        reported = true;
    }

    function reopen() external onlyHub {}

    function settle(uint32 winner, bool isWinner, uint256, uint256) external onlyHub {
        winnerEid = winner;
        uint256 handed = builder.settle(coin, winner, isWinner);
        if (handed > 0) IConsolidatorIn(builder.consolidator()).fromCurve(coinId, handed);
    }

    /// @dev Part of the hub's report: equal on every chain of the coin, so the reports match.
    function initialVirtualNative() external view returns (uint256) {
        return startMarketCap;
    }

    function initialVirtualToken() external view returns (uint256) {
        return chainShare;
    }
}
