// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAcrossSpokePool} from "../omni/AcrossUsdBridge.sol";

/**
 * @title AutoOrders (sasa): take profit, stop loss and buy the dip, run by sasa's keeper
 * @notice A user signs an order (EIP-712, free: nothing is sent to place it) and approves the
 * token it spends once. When the market reaches the order's price, sasa's keeper executes it
 * through a DEX router this contract allows (the race coins' routers, Relay's router for other
 * coins). What protects the user is checked here, not trusted to the keeper:
 *  - only the signed amount of the signed token is ever taken, once, before the deadline;
 *  - the user always gets at least the signed `minOut` (after the fee), or nothing happens;
 *  - whatever the router doesn't use goes straight back to the user;
 *  - the fee is fixed at 0.1% of the trade (it pays the keeper's network fees: the user pays,
 *    sasa doesn't); an Across fee, when the order sends money to another chain, is capped by
 *    the signed `maxRouteFee`.
 * The contract holds nothing between calls. The user can cancel an order on chain at any time
 * (or just remove the approval).
 *
 * Modes (signed):
 *  0 SWAP: sell coins for this chain's dollars, or buy coins with them, here.
 *  1 SELL_HOME: sell here, then send the dollars to the user's own address on the home chain
 *    (Base) through Across (the user is the depositor: anything undelivered is refunded to them).
 *  2 BUY_CROSS: on the home chain, send the dollars through Across to that chain's RaceCross,
 *    which buys the race coin there for the user (at least `minOut` coins, or the dollars stay
 *    with the user there).
 */
contract AutoOrders is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint8 public constant SWAP = 0;
    uint8 public constant SELL_HOME = 1;
    uint8 public constant BUY_CROSS = 2;

    /// @notice 0.1% of the trade, in dollars: taken from the dollars in (buys) or out (sells).
    uint256 public constant FEE_BPS = 10;
    uint32 public constant FILL_WINDOW = 4 hours;

    struct Order {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut; // what the user gets at least: dollars after the fee (sells), coins (buys)
        uint8 mode;
        uint256 destChainId; // BUY_CROSS: the chain the coin is bought on
        uint256 maxRouteFee; // most an Across leg may cost, in this chain's dollar units
        uint256 deadline;
        uint256 nonce; // any unique number per user
    }

    /// @notice What the keeper brings: the router call, and Across's fee when there is a leg.
    struct Route {
        address approveTo; // who may pull the tokens (address(0): the target itself)
        address target;
        bytes data;
        uint256 routeFee;
    }

    /// @notice Where BUY_CROSS sends the dollars for a chain (set once per chain).
    struct CrossRoute {
        address raceCross;
        address usdc;
        uint8 decimals;
        uint256 gasAsk; // gas top-up asked for (RaceCross gives it only if the user is low), dest units
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint8 mode,uint256 destChainId,uint256 maxRouteFee,uint256 deadline,uint256 nonce)"
    );

    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;
    IAcrossSpokePool public immutable spokePool; // address(0): no Across legs on this chain
    uint256 public immutable homeChainId;
    IERC20 public immutable homeUsdc;
    uint8 public immutable homeDecimals;

    address public feeTo;
    mapping(address => bool) public isKeeper;
    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public allowedSpender;
    mapping(uint256 chainId => CrossRoute) internal crossRoutes;
    /// @notice Orders that are done: executed or cancelled.
    mapping(address user => mapping(uint256 nonce => bool)) public used;

    event Executed(address indexed user, uint256 indexed nonce, uint8 mode, uint256 amountIn, uint256 amountOut, uint256 fee);
    event Cancelled(address indexed user, uint256 indexed nonce);
    event KeeperSet(address keeper, bool allowed);
    event RouterSet(address target, bool target_, bool spender);
    event FeeToSet(address feeTo);
    event CrossRouteSet(uint256 chainId, address raceCross);

    error NotKeeper();
    error Used();
    error Expired();
    error BadSignature();
    error BadOrder();
    error RouterNotAllowed();
    error TooLittle(uint256 got, uint256 minimum);
    error RouteFeeTooHigh();
    error NoRoute();
    error CallFailed(bytes reason);
    error BadConfig();
    error RouteFixed();

    constructor(
        address owner_,
        IERC20 usdc_,
        IAcrossSpokePool spokePool_,
        uint256 homeChainId_,
        IERC20 homeUsdc_,
        uint8 homeDecimals_,
        address feeTo_
    ) Ownable(owner_) EIP712("sasa AutoOrders", "1") {
        if (address(usdc_) == address(0) || feeTo_ == address(0)) revert BadConfig();
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(address(usdc_)).decimals();
        spokePool = spokePool_;
        homeChainId = homeChainId_;
        homeUsdc = homeUsdc_;
        homeDecimals = homeDecimals_;
        feeTo = feeTo_;
    }

    // ------------------------------------------------------------ the user

    /// @notice Cancels the caller's order `nonce` for good.
    function cancel(uint256 nonce) external {
        used[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    /// @notice The EIP-712 digest the user signs for `o`.
    function digest(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH, o.user, o.tokenIn, o.tokenOut, o.amountIn, o.minOut, o.mode, o.destChainId, o.maxRouteFee, o.deadline, o.nonce
                )
            )
        );
    }

    /// @notice The user's own key signed `d`, or (a smart wallet) the wallet accepts it. The key
    /// is checked first: a sasa account with EIP-7702 code still signs with it.
    function isUserSignature(address user, bytes32 d, bytes calldata sig) public view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(d, sig);
        if (err == ECDSA.RecoverError.NoError && signer == user) return true;
        return user.code.length > 0 && SignatureChecker.isValidERC1271SignatureNow(user, d, sig);
    }

    // ------------------------------------------------------------ the keeper

    function execute(Order calldata o, bytes calldata sig, Route calldata r) external nonReentrant returns (uint256 out) {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        if (block.timestamp > o.deadline) revert Expired();
        if (used[o.user][o.nonce]) revert Used();
        if (!isUserSignature(o.user, digest(o), sig)) revert BadSignature();
        used[o.user][o.nonce] = true;
        if (o.amountIn == 0 || o.tokenIn == o.tokenOut || o.user == address(0)) revert BadOrder();

        bool buying = o.tokenIn == address(usdc);
        if (!buying && o.tokenOut != address(usdc)) revert BadOrder(); // one side is always this chain's dollar

        // a sell takes what was signed, or what's left if the user sold some since (the minimum
        // scales down with it); a buy takes exactly what was signed
        uint256 take = o.amountIn;
        uint256 minOut = o.minOut;
        if (!buying) {
            uint256 bal = IERC20(o.tokenIn).balanceOf(o.user);
            if (bal < take) {
                if (bal == 0) revert BadOrder();
                minOut = Math.ceilDiv(o.minOut * bal, take); // rounded up: never below the signed rate
                take = bal;
            }
        }
        // every order names a real minimum (a zero minimum would let any route through)
        if (minOut == 0) revert BadOrder();
        // a token that charges on transfer gives less: use what came
        uint256 inBefore = IERC20(o.tokenIn).balanceOf(address(this));
        IERC20(o.tokenIn).safeTransferFrom(o.user, address(this), take);
        uint256 got = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;

        uint256 fee;
        if (o.mode == BUY_CROSS) {
            if (!buying) revert BadOrder();
            fee = (got * FEE_BPS) / 10_000;
            out = _buyCross(o, r, got - fee);
        } else if (o.mode == SWAP || o.mode == SELL_HOME) {
            if (o.mode == SELL_HOME && buying) revert BadOrder();
            if (buying) {
                fee = (got * FEE_BPS) / 10_000;
                out = _swap(o, r, got - fee, inBefore, fee);
                if (out < minOut) revert TooLittle(out, minOut);
                // what reaches the user is what counts (a coin that charges on transfer gives less)
                uint256 userBefore = IERC20(o.tokenOut).balanceOf(o.user);
                IERC20(o.tokenOut).safeTransfer(o.user, out);
                out = IERC20(o.tokenOut).balanceOf(o.user) - userBefore;
                if (out < minOut) revert TooLittle(out, minOut);
            } else {
                uint256 gross = _swap(o, r, got, inBefore, 0);
                fee = (gross * FEE_BPS) / 10_000;
                out = gross - fee;
                if (out < minOut) revert TooLittle(out, minOut);
                if (o.mode == SELL_HOME) _sendHome(o, r, out);
                else usdc.safeTransfer(o.user, out);
            }
        } else {
            revert BadOrder();
        }
        if (fee > 0) usdc.safeTransfer(feeTo, fee);
        emit Executed(o.user, o.nonce, o.mode, got, out, fee);
    }

    /// @dev Runs the router with `amount` of tokenIn; returns tokenOut received. Unused tokenIn
    /// goes back to the user; `keep` (the fee on a buy, still held) stays for the caller to pay.
    function _swap(Order calldata o, Route calldata r, uint256 amount, uint256 inBefore, uint256 keep) internal returns (uint256) {
        if (!allowedTarget[r.target] || (r.approveTo != address(0) && !allowedSpender[r.approveTo])) revert RouterNotAllowed();
        address spender = r.approveTo == address(0) ? r.target : r.approveTo;
        uint256 outBefore = IERC20(o.tokenOut).balanceOf(address(this));
        IERC20(o.tokenIn).forceApprove(spender, amount);
        (bool ok, bytes memory res) = r.target.call(r.data);
        if (!ok) revert CallFailed(res);
        IERC20(o.tokenIn).forceApprove(spender, 0);
        uint256 got = IERC20(o.tokenOut).balanceOf(address(this)) - outBefore;
        // anything of tokenIn the router left (beyond the fee still held) goes back to the user
        uint256 left = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;
        if (left > keep) IERC20(o.tokenIn).safeTransfer(o.user, left - keep);
        return got;
    }

    function _sendHome(Order calldata o, Route calldata r, uint256 amount) internal {
        if (address(spokePool) == address(0) || homeChainId == block.chainid) revert NoRoute();
        // the dollars arrive at the same address on Base: only for a plain key or a sasa account
        // (EIP-7702), whose address is theirs on every chain, never a contract wallet
        if (!_sameEverywhere(o.user)) revert BadOrder();
        if (r.routeFee > o.maxRouteFee || r.routeFee >= amount) revert RouteFeeTooHigh();
        uint256 outHome = _convert(amount - r.routeFee, usdcDecimals, homeDecimals);
        if (outHome == 0) revert RouteFeeTooHigh();
        usdc.forceApprove(address(spokePool), amount);
        spokePool.depositV3Now(o.user, o.user, address(usdc), address(homeUsdc), amount, outHome, homeChainId, address(0), FILL_WINDOW, 0, "");
        usdc.forceApprove(address(spokePool), 0);
    }

    function _buyCross(Order calldata o, Route calldata r, uint256 amount) internal returns (uint256) {
        CrossRoute memory c = crossRoutes[o.destChainId];
        if (c.raceCross == address(0) || address(spokePool) == address(0)) revert NoRoute();
        if (r.routeFee > o.maxRouteFee || r.routeFee >= amount) revert RouteFeeTooHigh();
        uint256 outThere = _convert(amount - r.routeFee, usdcDecimals, c.decimals);
        if (outThere == 0) revert RouteFeeTooHigh();
        // RaceCross's buy order (RaceCross.Order): coins to the user, at least minOut of them
        bytes memory message = abi.encode(
            uint8(0), abi.encode(o.user, o.tokenOut, o.minOut, c.gasAsk, block.timestamp + FILL_WINDOW)
        );
        usdc.forceApprove(address(spokePool), amount);
        spokePool.depositV3Now(o.user, c.raceCross, address(usdc), c.usdc, amount, outThere, o.destChainId, address(0), FILL_WINDOW, 0, message);
        usdc.forceApprove(address(spokePool), 0);
        return outThere;
    }

    /// @dev No code, or only an EIP-7702 delegation (0xef0100 ++ address): the user holds the key.
    function _sameEverywhere(address user) internal view returns (bool) {
        uint256 len = user.code.length;
        if (len == 0) return true;
        if (len != 23) return false;
        bytes memory c = user.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _convert(uint256 amount, uint8 from, uint8 to) internal pure returns (uint256) {
        if (from == to) return amount;
        if (from > to) return amount / (10 ** (from - to));
        return amount * (10 ** (to - from));
    }

    // ------------------------------------------------------------ owner

    function setKeeper(address k, bool allowed) external onlyOwner {
        isKeeper[k] = allowed;
        emit KeeperSet(k, allowed);
    }

    /// @notice Routers the keeper may use. A router can never take more than the order's amount,
    /// and every order still checks its minimum: a router only decides how well an order fills.
    function setRouter(address target, bool asTarget, bool asSpender) external onlyOwner {
        if (target == address(0) || target == address(usdc)) revert BadConfig();
        allowedTarget[target] = asTarget;
        allowedSpender[target] = asSpender;
        emit RouterSet(target, asTarget, asSpender);
    }

    /// @notice Sends out tokens that ended up here by mistake. The contract holds nothing
    /// between orders: every order's tokens leave in the same transaction.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert BadConfig();
        token.safeTransfer(to, amount);
    }

    function setFeeTo(address feeTo_) external onlyOwner {
        if (feeTo_ == address(0)) revert BadConfig();
        feeTo = feeTo_;
        emit FeeToSet(feeTo_);
    }

    /// @notice Where dip buys for `chainId` go (that chain's RaceCross). Set once: never changed.
    function setCrossRoute(uint256 chainId, CrossRoute calldata c) external onlyOwner {
        if (crossRoutes[chainId].raceCross != address(0)) revert RouteFixed();
        if (c.raceCross == address(0) || c.usdc == address(0) || chainId == block.chainid) revert BadConfig();
        crossRoutes[chainId] = c;
        emit CrossRouteSet(chainId, c.raceCross);
    }

    function crossRouteOf(uint256 chainId) external view returns (CrossRoute memory) {
        return crossRoutes[chainId];
    }

    function renounceOwnership() public pure override {
        revert BadConfig();
    }
}
