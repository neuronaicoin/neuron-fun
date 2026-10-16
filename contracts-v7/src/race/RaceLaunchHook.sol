// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice The builder's side of the race-end record (see RaceLaunchHook.beforeSwap).
interface IRaceEndRecorder {
    /// Writes down the money in the coin's pool as the race ended; true once that is done
    /// (or nothing is left to write down), false while the race is still on.
    function recordRaceEnd(PoolKey calldata key) external returns (bool done);
}

/// @title RaceLaunchHook (sasa v7)
/// @notice Hook of every sasa race pool.
///   * Pools with this hook can only be opened by sasa's RaceBuilder (never early, never at
///     another price).
///   * Opening fee: 10% at the pool's first second, sliding down linearly to 2% after two
///     minutes; 2% from then on. Swaps made by the RaceBuilder itself (the creator's first
///     buy, buybacks) always pay the 2% floor.
///   * A pool whose chain lost the race is shut by the RaceBuilder and refuses all swaps.
///   * The race result is the money in the pool when the five minutes end. Before the first
///     swap after that moment, the RaceBuilder writes the pool's money down (as it is before
///     that swap), so no trade after the race can change its result.
/// It never holds funds and never alters swap amounts.
contract RaceLaunchHook {
    using PoolIdLibrary for PoolKey;

    uint24 public constant OPENING_FEE = 100_000; // 10%
    uint24 public constant FLOOR_FEE = 20_000; // 2%
    uint256 public constant FEE_WINDOW = 120; // two minutes
    uint256 public constant RACE_SECONDS = 300; // the same five minutes as the builder's

    address public immutable poolManager;
    address public immutable builder;

    mapping(PoolId => uint256) public openedAt;
    mapping(PoolId => bool) public shut;
    mapping(PoolId => bool) public raceEndRecorded;

    event Shut(PoolId indexed id);

    error OnlyPoolManager();
    error OnlyRaceBuilder();
    error UnknownRacePool();
    error RaceLostPoolShut();

    constructor(address poolManager_, address builder_) {
        poolManager = poolManager_;
        builder = builder_;
    }

    function openingFeeAt(uint256 start, uint256 nowTs) public pure returns (uint24) {
        if (nowTs <= start) return OPENING_FEE;
        if (nowTs >= start + FEE_WINDOW) return FLOOR_FEE;
        uint256 elapsed = nowTs - start;
        return uint24(OPENING_FEE - ((uint256(OPENING_FEE - FLOOR_FEE) * elapsed) / FEE_WINDOW));
    }

    function feeNow(PoolKey calldata key) external view returns (uint24) {
        uint256 start = openedAt[key.toId()];
        if (start == 0) return FLOOR_FEE;
        return openingFeeAt(start, block.timestamp);
    }

    /// @notice Closes a pool that lost its race. Only the builder, and it never reopens.
    function shutPool(PoolKey calldata key) external {
        if (msg.sender != builder) revert OnlyRaceBuilder();
        PoolId id = key.toId();
        if (openedAt[id] == 0) revert UnknownRacePool();
        shut[id] = true;
        emit Shut(id);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external returns (bytes4) {
        if (msg.sender != poolManager) revert OnlyPoolManager();
        if (sender != builder) revert OnlyRaceBuilder();
        openedAt[key.toId()] = block.timestamp;
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != poolManager) revert OnlyPoolManager();
        PoolId id = key.toId();
        uint256 start = openedAt[id];
        if (start == 0) revert UnknownRacePool();
        if (shut[id]) revert RaceLostPoolShut();
        // the first swap after the five minutes: the race's money is written down first.
        // No try/catch on purpose: if the record can't be written, the swap doesn't happen
        // (a swap must never slip past the record).
        if (!raceEndRecorded[id] && block.timestamp >= start + RACE_SECONDS) {
            if (IRaceEndRecorder(builder).recordRaceEnd(key)) raceEndRecorded[id] = true;
        }
        uint24 fee = sender == builder ? FLOOR_FEE : openingFeeAt(start, block.timestamp);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
