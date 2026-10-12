// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";

/**
 * TESTNET ONLY. None of these contracts is ever deployed on a mainnet: there the race
 * uses the chain's real dollar, Chainlink and the real dollar pools.
 */

/// @notice sasa v7 testnet play money: 6 decimals, $100 a day from the faucet for anyone,
/// a LayerZero OFT (so the dollar bridge moves it between testnets exactly like mainnet
/// moves real dollars), and an owner mint that only seeds the test dollar pools.
contract TestUsdV7 is OFT {
    uint256 public constant FAUCET_AMOUNT = 100e6;
    uint256 public constant FAUCET_EVERY = 1 days;
    mapping(address => uint256) public lastFaucet;

    event Fauceted(address indexed to, uint256 amount);

    error TooSoon(uint256 next);

    constructor(address endpoint_, address owner_) OFT("Test USDC", "USDC", endpoint_, owner_) Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        uint256 next = lastFaucet[to] + FAUCET_EVERY;
        if (lastFaucet[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastFaucet[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit Fauceted(to, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// @notice Chainlink-shaped price feed for testnets that have no Chainlink feed. The owner
/// sets the price; everything else (decimals, round data, staleness) looks like Chainlink.
contract TestFeed is Ownable {
    string public description;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    event PriceSet(int256 answer, uint256 updatedAt);

    constructor(string memory description_, int256 answer_, address owner_) Ownable(owner_) {
        description = description_;
        _set(answer_);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function set(int256 answer_) external onlyOwner {
        _set(answer_);
    }

    /// @notice Anyone may refresh the timestamp (keeps the feed "fresh" on a quiet testnet).
    function touch() external {
        _set(answer);
    }

    function _set(int256 a) private {
        require(a > 0, "price");
        answer = a;
        updatedAt = block.timestamp;
        roundId += 1;
        emit PriceSet(a, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

interface ITestFeedPrice {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface ITestWrapped {
    function deposit() external payable;
}

/**
 * @notice A stand-in for the PancakeSwap v3 USDC/WBNB pool on BNB testnet: the same
 * `swap` + callback shape the builder and the trade router use, but it fills every
 * exact-in swap at the feed price with a 0.05% fee (a deep pool with no slippage), out of
 * reserves the owner tops up. token0/token1 are sorted like a real pool.
 */
contract TestDollarPool is Ownable {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    IERC20 public immutable usd;
    IERC20 public immutable wnative;
    uint8 public immutable usdDecimals;
    ITestFeedPrice public immutable feed;
    uint256 public constant FEE_BPS = 5; // 0.05%

    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1);

    constructor(IERC20 usd_, IERC20 wnative_, uint8 usdDecimals_, ITestFeedPrice feed_, address owner_) Ownable(owner_) {
        usd = usd_;
        wnative = wnative_;
        usdDecimals = usdDecimals_;
        feed = feed_;
        (token0, token1) = address(usd_) < address(wnative_) ? (address(usd_), address(wnative_)) : (address(wnative_), address(usd_));
    }

    receive() external payable {
        ITestWrapped(address(wnative)).deposit{value: msg.value}();
    }

    /// @dev dollars (usd units) per 1e18 wei of the native coin, from the feed
    function _price() internal view returns (uint256) {
        (, int256 a,,,) = feed.latestRoundData();
        require(a > 0, "feed");
        return (uint256(a) * 10 ** usdDecimals) / 10 ** feed.decimals();
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 p = _price();
        uint256 inAfterFee = amountIn - (amountIn * FEE_BPS) / 10_000;
        uint256 out = tin == address(usd) ? (inAfterFee * 1e18) / p : (inAfterFee * p) / 1e18;
        require(IERC20(tout).balanceOf(address(this)) >= out, "test pool: top up reserves");
        uint256 before = IERC20(tin).balanceOf(address(this));
        IERC20(tout).safeTransfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        ITestV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        require(IERC20(tin).balanceOf(address(this)) >= before + amountIn, "not paid");
        emit Swap(msg.sender, recipient, amount0, amount1);
    }

    /// @notice The owner takes reserves back (testnet housekeeping).
    function withdraw(IERC20 t, address to, uint256 amount) external onlyOwner {
        t.safeTransfer(to, amount);
    }
}

interface ITestV3Callback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

/**
 * @notice TESTNET ONLY. Our test ETH / dollar Uniswap v4 pool is tiny and nobody arbitrages
 * it, so after a few launches (or when the real Chainlink feed moves) its price drifts away
 * from the feed and the builders refuse to swap (Slippage). This pushes the pool back to a
 * target price with one swap that stops exactly at that price. The caller pays whichever
 * side the pool needs (ETH as msg.value, dollars via approve) and receives the other side.
 * On a mainnet the real pool is deep and arbitraged: this contract is never deployed there.
 */
contract TestPoolRebalancer is IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    error OnlyPoolManager();

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    /// @param key the ETH / dollar pool (currency0 must be native ETH)
    /// @param targetSqrtPriceX96 where the price should end up
    function rebalance(PoolKey calldata key, uint160 targetSqrtPriceX96) external payable {
        poolManager.unlock(abi.encode(key, targetSqrtPriceX96, msg.sender, msg.value));
        if (address(this).balance > 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (PoolKey memory key, uint160 target, address payer, uint256 ethBudget) = abi.decode(data, (PoolKey, uint160, address, uint256));
        (uint160 now_,,,) = StateLibrary.getSlot0(poolManager, key.toId());
        if (now_ == target) return "";
        // zeroForOne lowers the price: sell ETH when the pool is above the target. Selling ETH
        // spends at most the ETH sent along (the price then gets as close as that allows);
        // buying ETH spends test dollars, which are free, so that side is unlimited.
        bool zeroForOne = now_ > target;
        if (zeroForOne && ethBudget == 0) return "";
        int256 amountIn = zeroForOne ? -int256(ethBudget) : -int256(uint256(type(uint128).max));
        poolManager.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: amountIn, sqrtPriceLimitX96: target}), "");
        Currency inC = zeroForOne ? key.currency0 : key.currency1;
        Currency outC = zeroForOne ? key.currency1 : key.currency0;
        int256 owed = poolManager.currencyDelta(address(this), inC);
        if (owed < 0) {
            if (inC.isAddressZero()) {
                poolManager.settle{value: uint256(-owed)}();
            } else {
                poolManager.sync(inC);
                IERC20(Currency.unwrap(inC)).safeTransferFrom(payer, address(poolManager), uint256(-owed));
                poolManager.settle();
            }
        }
        int256 credit = poolManager.currencyDelta(address(this), outC);
        if (credit > 0) poolManager.take(outC, payer, uint256(credit));
        return "";
    }

    receive() external payable {}
}
