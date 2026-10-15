// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";

import {IAcrossSpokePool} from "../omni/AcrossUsdBridge.sol";
import {IRaceBuilderEthPools} from "./RaceTradeEth.sol";
import {IWrappedNative, IPancakeV3PoolMin} from "./RaceBuilderPcs.sol";
import {RaceFactory} from "./RaceFactory.sol";

/// @notice The trade routers' shared shape (RaceTradeEth, RaceTradePcs, UsdPoolRouter).
interface IRaceRouter {
    function buy(address coin, uint256 usdcIn, uint256 minCoinsOut, address to, uint256 deadline) external returns (uint256);
    function sell(address coin, uint256 coinsIn, uint256 minUsdcOut, address to, uint256 deadline) external returns (uint256);
}

/**
 * @title RaceCross (sasa v7): trade on this chain with dollars kept on Base
 * @notice sasa accounts keep their dollars on Base. To buy a coin on this chain, the user's
 * account sends dollars from Base through Across to this contract, with the order in the
 * message. Across's relayer pays this chain's network fee for the delivery, so the user needs
 * no gas here to buy:
 *  - if the user has almost no gas on this chain, a little of the money (at most 50 cents)
 *    becomes gas for them first, so they can sell later;
 *  - the rest buys the coin for the user. If the buy can't happen (price moved past their
 *    minimum, deadline passed), the dollars go to the user here instead: nothing is ever stuck.
 * To launch a coin on this chain, the same way: the message carries the launch and the user's
 * signature over it (only the user can launch as themselves); the race fee and the first buy
 * come out of the dollars that arrived, and the coin, its fees and the first-buy coins are the
 * user's. A launch that can't happen (closed, too late, too little) is never filled: Across
 * returns the dollars to the user on Base.
 * To sell, the user calls `sellAndSendHome`: the coins are sold and the dollars go back to the
 * user's own address on Base through Across, in the same transaction.
 *
 * Holds nothing between calls, has no owner and no settings. Everything it moves belongs to
 * the user who sent it, and only goes to that user.
 */
abstract contract RaceCross is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice The Across message: `abi.encode(kind, abi.encode(Order or LaunchOrder))`.
    uint8 public constant KIND_BUY = 0;
    uint8 public constant KIND_LAUNCH = 1;

    /// @notice What the Across message carries for a buy.
    struct Order {
        address user; // gets the coins (and the gas, and any refund)
        address coin;
        uint256 minCoinsOut;
        uint256 gasUsd; // dollars (this chain's units) to turn into gas if the user has almost none
        uint256 deadline;
    }

    /// @notice What the Across message carries for a launch.
    struct LaunchOrder {
        address user; // the creator: gets the coin, its fees, the first-buy coins, gas, any refund
        RaceFactory.Launch launch; // exactly what the user would send to the factory themselves
        uint256 gasUsd;
        uint256 deadline; // no launch after this (the race starts together on every chain)
        bytes signature; // the user's EIP-712 signature over LaunchAuth
    }

    bytes32 public constant LAUNCH_AUTH_TYPEHASH =
        keccak256("LaunchAuth(address user,bytes32 launch,uint256 gasUsd,uint256 deadline)");

    uint32 public constant FILL_WINDOW = 4 hours;
    /// @notice A fill must leave at least this much gas for the buy: a relayer can't starve the
    /// buy on purpose to turn it into a refund.
    uint256 public constant BUY_GAS = 500_000;

    IAcrossSpokePool public immutable spokePool;
    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;
    IRaceRouter public immutable router;
    RaceFactory public immutable factory;
    /// @notice Base: where the dollars go home to.
    uint256 public immutable homeChainId;
    IERC20 public immutable homeUsdc;
    uint8 public immutable homeDecimals;
    /// @notice A user with less native gas than this gets a gas top-up with a buy.
    uint256 public immutable gasFloor;
    /// @notice Most a buy turns into gas: 50 cents, and never more than a quarter of the buy.
    uint256 public immutable maxGasUsd;

    event Bought(address indexed user, address indexed coin, uint256 usdcIn, uint256 coinsOut, uint256 gasUsd);
    event Refunded(address indexed user, address indexed coin, uint256 usdc);
    event SentHome(address indexed user, uint256 amount, uint256 outputAmount);
    event LaunchedFor(address indexed user, address indexed coin, uint256 usdcIn, uint256 gasUsd);

    error NotSpokePool();
    error WrongToken();
    error NoUser();
    error FeeTooHigh();
    error NotSelf();
    error LowGas();
    error GasSendFailed();
    error BadSignature();
    error UnknownKind();
    error TooLate();
    error AlreadyLaunched();
    error NotEnough();

    constructor(
        IAcrossSpokePool spokePool_,
        IERC20 usdc_,
        IRaceRouter router_,
        RaceFactory factory_,
        uint256 homeChainId_,
        IERC20 homeUsdc_,
        uint8 homeDecimals_,
        uint256 gasFloor_
    ) EIP712("sasa RaceCross", "1") {
        spokePool = spokePool_;
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        router = router_;
        factory = factory_;
        homeChainId = homeChainId_;
        homeUsdc = homeUsdc_;
        homeDecimals = homeDecimals_;
        gasFloor = gasFloor_;
        maxGasUsd = (50 * 10 ** usdcDecimals) / 100;
    }

    // ------------------------------------------------------------ buy (Across delivers)

    /// @notice Across's SpokePool calls this right after paying `amount` of `token` here.
    function handleV3AcrossMessage(address token, uint256 amount, address, bytes memory message) external nonReentrant {
        if (msg.sender != address(spokePool)) revert NotSpokePool();
        if (token != address(usdc)) revert WrongToken();
        (uint8 kind, bytes memory body) = abi.decode(message, (uint8, bytes));
        if (kind == KIND_BUY) _buy(abi.decode(body, (Order)), amount);
        else if (kind == KIND_LAUNCH) _launch(abi.decode(body, (LaunchOrder)), amount);
        else revert UnknownKind();
        // whatever wasn't used (all of it on a refund) goes to the user
        uint256 rest = usdc.balanceOf(address(this));
        if (rest > 0) usdc.safeTransfer(_userOf(kind, body), rest);
    }

    function _userOf(uint8 kind, bytes memory body) internal pure returns (address) {
        return kind == KIND_BUY ? abi.decode(body, (Order)).user : abi.decode(body, (LaunchOrder)).user;
    }

    function _buy(Order memory o, uint256 amount) internal {
        // no user to deliver to: refuse, so Across never fills and refunds the sender on Base
        if (o.user == address(0)) revert NoUser();
        uint256 gas = _topUp(o.user, o.gasUsd, amount);
        uint256 left = amount - gas;
        if (gasleft() < BUY_GAS) revert LowGas();
        usdc.forceApprove(address(router), left);
        uint256 g1 = gasleft();
        try router.buy(o.coin, left, o.minCoinsOut, o.user, o.deadline) returns (uint256 out) {
            emit Bought(o.user, o.coin, left, out, gas);
        } catch {
            // ran out of gas (a starved fill) rather than refused: undo, so Across doesn't count it
            if (gasleft() < g1 / 32) revert LowGas();
            emit Refunded(o.user, o.coin, left);
        }
        usdc.forceApprove(address(router), 0);
    }

    /// @dev A launch that can't happen is never filled: the whole fill reverts, so no relayer can
    /// deliver it and Across returns the dollars to the user on Base after the deposit's fill
    /// deadline. No partial outcome, and no gas trick by a relayer can change that.
    function _launch(LaunchOrder memory o, uint256 amount) internal {
        if (o.user == address(0)) revert NoUser();
        // only the user can launch as the user
        if (!isUserSignature(o.user, launchDigest(o.user, o.launch, o.gasUsd, o.deadline), o.signature)) revert BadSignature();
        if (block.timestamp > o.deadline) revert TooLate();
        // already launched (a replay): refused before the deploy, which would burn all the gas
        if (factory.coinAddress(o.user, o.launch.launchKey).code.length != 0) revert AlreadyLaunched();
        uint256 gas = _topUp(o.user, o.gasUsd, amount);
        uint256 cost = o.launch.firstBuy + factory.raceFee();
        if (cost > amount - gas) revert NotEnough();
        usdc.forceApprove(address(factory), cost);
        (address coin,) = factory.launchFor(o.user, o.launch);
        usdc.forceApprove(address(factory), 0);
        emit LaunchedFor(o.user, coin, cost, gas);
    }

    /// @notice The user's own key signed `digest`, or (a smart wallet) the wallet accepts it. The
    /// key is checked first: a sasa account with EIP-7702 code on this chain still signs with it.
    function isUserSignature(address user, bytes32 digest, bytes memory signature) public view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && signer == user) return true;
        return user.code.length > 0 && SignatureChecker.isValidERC1271SignatureNow(user, digest, signature);
    }

    /// @notice What the user signs (EIP-712, this contract on this chain) to launch through Across.
    function launchDigest(address user, RaceFactory.Launch memory l, uint256 gasUsd, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(LAUNCH_AUTH_TYPEHASH, user, keccak256(abi.encode(l)), gasUsd, deadline)));
    }

    /// @dev Turns part of `amount` into gas for `user` if they have almost none; returns how much.
    function _topUp(address user, uint256 asked, uint256 amount) internal returns (uint256 gas) {
        gas = gasFor(user, asked, amount);
        if (gas > 0) {
            uint256 g0 = gasleft();
            try this.dropGas(user, gas) {} catch {
                if (gasleft() < g0 / 32) revert LowGas(); // starved, not refused: no fill
                gas = 0; // no top-up then; everything goes to the trade
            }
        }
    }

    /// @notice How much of an `amount` buy becomes gas for `user` (0 if they have enough).
    function gasFor(address user, uint256 asked, uint256 amount) public view returns (uint256) {
        if (asked == 0 || _gasBalance(user) >= gasFloor) return 0;
        uint256 g = asked < maxGasUsd ? asked : maxGasUsd;
        uint256 quarter = amount / 4;
        return g < quarter ? g : quarter;
    }

    /// @notice Only this contract (inside a buy), so a failed top-up can't stop the buy.
    function dropGas(address user, uint256 usd) external {
        if (msg.sender != address(this)) revert NotSelf();
        _dropGas(user, usd);
    }

    // ------------------------------------------------------------ sell (the user calls)

    /**
     * @notice Sells `coinsIn` of the caller's `coin` (approve this contract first) and sends the
     * dollars to the caller's own address on Base through Across. `relayFee` (this chain's
     * dollar units) is what Across's relayer keeps, from Across's quote.
     */
    function sellAndSendHome(address coin, uint256 coinsIn, uint256 minUsdcOut, uint256 relayFee, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        IERC20(coin).safeTransferFrom(msg.sender, address(this), coinsIn);
        IERC20(coin).forceApprove(address(router), coinsIn);
        usdcOut = router.sell(coin, coinsIn, minUsdcOut, address(this), deadline);
        IERC20(coin).forceApprove(address(router), 0);
        // coins the router didn't sell go back to the seller
        uint256 unsold = IERC20(coin).balanceOf(address(this));
        if (unsold > 0) IERC20(coin).safeTransfer(msg.sender, unsold);
        _sendHome(msg.sender, usdcOut, relayFee);
    }

    /// @notice Sends `amount` of the caller's dollars on this chain home to Base.
    function sendHome(uint256 amount, uint256 relayFee) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _sendHome(msg.sender, amount, relayFee);
    }

    function _sendHome(address user, uint256 amount, uint256 relayFee) internal {
        if (relayFee >= amount) revert FeeTooHigh();
        uint256 out = convertDecimals(amount - relayFee, usdcDecimals, homeDecimals);
        if (out == 0) revert FeeTooHigh();
        usdc.forceApprove(address(spokePool), amount);
        // the user is the depositor: if no relayer fills it, Across refunds the user, not this contract
        spokePool.depositV3Now(
            user, user, address(usdc), address(homeUsdc), amount, out, homeChainId, address(0), FILL_WINDOW, 0, ""
        );
        usdc.forceApprove(address(spokePool), 0);
        emit SentHome(user, amount, out);
    }

    /// @notice `amount` with `from` decimals expressed with `to` decimals (rounded down).
    function convertDecimals(uint256 amount, uint8 from, uint8 to) public pure returns (uint256) {
        if (from == to) return amount;
        if (from > to) return amount / (10 ** (from - to));
        return amount * (10 ** (to - from));
    }

    // ------------------------------------------------------------ per chain

    function _gasBalance(address user) internal view virtual returns (uint256) {
        return user.balance;
    }

    /// @dev Turns `usd` of this contract's dollars into native gas for `user`.
    function _dropGas(address user, uint256 usd) internal virtual;

    /// @dev A wallet that won't take the gas (or burns gas taking it) only loses its own top-up.
    function _sendGas(address user, uint256 amount) internal {
        (bool ok,) = user.call{value: amount, gas: 100_000}("");
        if (!ok) revert GasSendFailed();
    }
}

/// @notice Base / Robinhood Chain: gas is ETH, bought from the chain's ETH/dollar Uniswap v4 pool.
contract RaceCrossEth is RaceCross, IUnlockCallback {
    using SafeERC20 for IERC20;
    using TransientStateLibrary for IPoolManager;

    IRaceBuilderEthPools public immutable builder;
    IPoolManager public immutable poolManager;
    Currency internal constant ETH = Currency.wrap(address(0));
    bool private _swapping;

    error OnlyPoolManager();

    constructor(
        IAcrossSpokePool spokePool_,
        IRaceBuilderEthPools builder_,
        IRaceRouter router_,
        RaceFactory factory_,
        uint256 homeChainId_,
        IERC20 homeUsdc_,
        uint8 homeDecimals_,
        uint256 gasFloor_
    ) RaceCross(spokePool_, builder_.usdc(), router_, factory_, homeChainId_, homeUsdc_, homeDecimals_, gasFloor_) {
        builder = builder_;
        poolManager = builder_.poolManager();
    }

    function _dropGas(address user, uint256 usd) internal override {
        uint256 b0 = address(this).balance;
        _swapping = true;
        poolManager.unlock(abi.encode(user, usd));
        _swapping = false;
        _sendGas(user, address(this).balance - b0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_swapping) revert OnlyPoolManager();
        (address user, uint256 usd) = abi.decode(data, (address, uint256));
        PoolKey memory k = builder.dollarPoolKey();
        bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
        poolManager.swap(
            k,
            SwapParams({
                zeroForOne: usdcIs0,
                amountSpecified: -int256(usd),
                sqrtPriceLimitX96: usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );
        Currency u = Currency.wrap(address(usdc));
        int256 owed = poolManager.currencyDelta(address(this), u);
        if (owed < 0) {
            poolManager.sync(u);
            usdc.safeTransfer(address(poolManager), uint256(-owed));
            poolManager.settle();
        }
        int256 eth = poolManager.currencyDelta(address(this), ETH);
        if (eth > 0) poolManager.take(ETH, address(this), uint256(eth));
        return abi.encode(user);
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
    }
}

/// @notice BNB Chain: gas is BNB, bought from the PancakeSwap v3 USDC/WBNB pool the builder uses.
contract RaceCrossPcs is RaceCross {
    using SafeERC20 for IERC20;

    uint160 internal constant V3_MIN_SQRT = 4295128739 + 1;
    uint160 internal constant V3_MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    IPancakeV3PoolMin public immutable dollarPool;
    IWrappedNative public immutable wbnb;
    bool internal immutable usdcIsToken0;
    bool private _swapping;

    error NotOurCall();

    constructor(
        IAcrossSpokePool spokePool_,
        IERC20 usdc_,
        IWrappedNative wbnb_,
        IPancakeV3PoolMin dollarPool_,
        IRaceRouter router_,
        RaceFactory factory_,
        uint256 homeChainId_,
        IERC20 homeUsdc_,
        uint8 homeDecimals_,
        uint256 gasFloor_
    ) RaceCross(spokePool_, usdc_, router_, factory_, homeChainId_, homeUsdc_, homeDecimals_, gasFloor_) {
        dollarPool = dollarPool_;
        wbnb = wbnb_;
        usdcIsToken0 = dollarPool_.token0() == address(usdc_);
    }

    receive() external payable {
        if (msg.sender != address(wbnb)) revert NotOurCall();
    }

    function _dropGas(address user, uint256 usd) internal override {
        uint256 w0 = IERC20(address(wbnb)).balanceOf(address(this));
        _swapping = true;
        dollarPool.swap(address(this), usdcIsToken0, int256(usd), usdcIsToken0 ? V3_MIN_SQRT : V3_MAX_SQRT, bytes(""));
        _swapping = false;
        uint256 got = IERC20(address(wbnb)).balanceOf(address(this)) - w0;
        wbnb.withdraw(got);
        _sendGas(user, got);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(dollarPool) || !_swapping) revert NotOurCall();
        // only USDC is ever paid in
        if (amount0Delta > 0) usdc.safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) usdc.safeTransfer(msg.sender, uint256(amount1Delta));
    }
}

/// @notice Arc: gas is USDC itself, so the "gas" is simply left with the user as dollars.
contract RaceCrossUsdc is RaceCross {
    using SafeERC20 for IERC20;

    constructor(
        IAcrossSpokePool spokePool_,
        IERC20 usdc_,
        IRaceRouter router_,
        RaceFactory factory_,
        uint256 homeChainId_,
        IERC20 homeUsdc_,
        uint8 homeDecimals_,
        uint256 gasFloor_
    ) RaceCross(spokePool_, usdc_, router_, factory_, homeChainId_, homeUsdc_, homeDecimals_, gasFloor_) {}

    /// @dev On Arc the dollar balance is the gas balance (in the token's own units).
    function _gasBalance(address user) internal view override returns (uint256) {
        return usdc.balanceOf(user);
    }

    function _dropGas(address user, uint256 usd) internal override {
        usdc.safeTransfer(user, usd);
    }
}
