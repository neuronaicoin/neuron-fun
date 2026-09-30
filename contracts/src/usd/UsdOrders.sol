// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUsdOrderCurve {
    function state() external view returns (uint8);
    function token() external view returns (address);
    function buy(uint256 amountIn, uint256 minTokensOut, address recipient) external returns (uint256);
    function sell(uint256 tokenAmount, uint256 minNativeOut, address recipient) external returns (uint256);
}

interface IUsdOrderRouter {
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address recipient, uint256 deadline) external returns (uint256);
    function sell(address token, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline)
        external
        returns (uint256);
}

/**
 * @title SasaOrders
 * @notice Auto orders for sasa coins: take profit, stop loss and buy the dip.
 * They run while the owner is away, and nobody (not the keeper, not sasa)
 * can fill them on worse terms than the owner set.
 *
 * Every order carries a window for what the trade must return:
 *   minOut <= out <= maxOut
 * - Take profit (sell): minOut = the value to sell at, maxOut = no limit.
 * - Stop loss (sell): maxOut = the stop value (so it only fills once the
 *   coins are worth that little), minOut = the lowest value accepted
 *   (the stop minus the slippage the owner allowed).
 * - Buy the dip (buy): minOut = the tokens the money must buy at the dip
 *   price, maxOut = no limit.
 * The window is checked against the real trade in the same transaction, so
 * no price oracle is needed and a keeper can't fill early or badly.
 *
 * Sells use an allowance: the coins stay in the owner's wallet until the
 * order fills (sold elsewhere = the order fills for what's left, or skips).
 * Buys hold the owner's money here until they fill or are cancelled.
 * Before graduation orders trade on the coin's curve; after, on its pool
 * through the router the owner picked. Anyone may call execute().
 */
/// @dev USD edition (v5): buy orders hold USDC (approve this contract first)
/// and sells pay out USDC. Same rules and the same window check as v4.
contract UsdOrders is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The money orders are paid in (USDC).
    IERC20 public immutable usdc;

    error ZeroAddress();

    constructor(IERC20 usdc_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    uint8 internal constant TRADING = 0;
    uint8 internal constant GRADUATED = 2;

    struct Order {
        address owner;
        address curve;
        address token;
        address router;
        bool isBuy;
        bool open;
        uint64 expiry; // 0 = never
        uint256 amount; // tokens to sell, or money to spend (wei)
        uint256 minOut;
        uint256 maxOut;
    }

    uint256 public nextId = 1;
    mapping(uint256 id => Order) public orders;
    mapping(address owner => uint256[]) internal _ordersOf;

    event Placed(
        uint256 indexed id,
        address indexed owner,
        address indexed curve,
        bool isBuy,
        uint256 amount,
        uint256 minOut,
        uint256 maxOut,
        uint64 expiry
    );
    event Cancelled(uint256 indexed id, address indexed owner, uint256 refund);
    event Executed(uint256 indexed id, address indexed owner, address indexed curve, bool isBuy, uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error NotOpen();
    error Expired();
    error BadOrder();
    error NothingToSell();
    error OutsideWindow(uint256 out, uint256 minOut, uint256 maxOut);
    error RefundFailed();

    // ------------------------------------------------------------ placing

    /// @notice Sell `amount` of the coin once a sale returns between `minOut` and `maxOut`.
    function placeSell(address curve, address router, uint256 amount, uint256 minOut, uint256 maxOut, uint64 expiry)
        external
        returns (uint256 id)
    {
        if (amount == 0 || minOut == 0 || maxOut < minOut || curve == address(0)) revert BadOrder();
        id = _place(curve, router, false, amount, minOut, maxOut, expiry);
    }

    /// @notice Set aside `amount` USDC (pulled now) and spend it once it buys between `minOut` and `maxOut` tokens.
    function placeBuy(address curve, address router, uint256 amount, uint256 minOut, uint256 maxOut, uint64 expiry)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (amount == 0 || minOut == 0 || maxOut < minOut || curve == address(0)) revert BadOrder();
        id = _place(curve, router, true, amount, minOut, maxOut, expiry);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function _place(address curve, address router, bool isBuy, uint256 amount, uint256 minOut, uint256 maxOut, uint64 expiry)
        private
        returns (uint256 id)
    {
        if (expiry != 0 && expiry <= block.timestamp) revert Expired();
        address token = IUsdOrderCurve(curve).token();
        if (token == address(0)) revert BadOrder();
        id = nextId++;
        orders[id] = Order(msg.sender, curve, token, router, isBuy, true, expiry, amount, minOut, maxOut);
        _ordersOf[msg.sender].push(id);
        emit Placed(id, msg.sender, curve, isBuy, amount, minOut, maxOut, expiry);
    }

    /// @notice Cancel an open order. A buy gets its money back.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (!o.open) revert NotOpen();
        o.open = false;
        uint256 refund = o.isBuy ? o.amount : 0;
        emit Cancelled(id, msg.sender, refund);
        if (refund > 0) _pay(msg.sender, refund);
    }

    // ------------------------------------------------------------ filling

    /// @notice Fills an order if the market allows it right now. Anyone may call.
    function execute(uint256 id) external nonReentrant returns (uint256 out) {
        Order storage o = orders[id];
        if (!o.open) revert NotOpen();
        if (o.expiry != 0 && block.timestamp > o.expiry) revert Expired();
        o.open = false; // effects first; a revert below reopens it

        uint8 st = IUsdOrderCurve(o.curve).state();
        bool pool = st == GRADUATED;
        if (!pool && st != TRADING && o.isBuy) revert BadOrder(); // closed curves take no buys
        if (pool && o.router == address(0)) revert BadOrder();

        if (o.isBuy) {
            uint256 before = usdc.balanceOf(address(this));
            address spender = pool ? o.router : o.curve;
            usdc.forceApprove(spender, o.amount);
            out = pool
                ? IUsdOrderRouter(o.router).buy(o.token, o.amount, o.minOut, o.owner, block.timestamp)
                : IUsdOrderCurve(o.curve).buy(o.amount, o.minOut, o.owner);
            usdc.forceApprove(spender, 0);
            if (out < o.minOut || out > o.maxOut) revert OutsideWindow(out, o.minOut, o.maxOut);
            // Only what was spent is pulled (a sold-out curve spends less): return the rest.
            uint256 used = before - usdc.balanceOf(address(this));
            if (used < o.amount) usdc.safeTransfer(o.owner, o.amount - used);
            emit Executed(id, o.owner, o.curve, true, used, out);
        } else {
            IERC20 t = IERC20(o.token);
            uint256 amt = o.amount;
            uint256 bal = t.balanceOf(o.owner);
            uint256 allow = t.allowance(o.owner, address(this));
            if (bal < amt) amt = bal;
            if (allow < amt) amt = allow;
            if (amt == 0) revert NothingToSell();
            // A smaller fill is held to the same price: scale the window.
            uint256 minOut = (o.minOut * amt) / o.amount;
            uint256 maxOut = o.maxOut == type(uint256).max ? type(uint256).max : (o.maxOut * amt) / o.amount;
            if (minOut == 0) minOut = 1;
            t.safeTransferFrom(o.owner, address(this), amt);
            address spender = pool ? o.router : o.curve;
            t.forceApprove(spender, amt);
            out = pool
                ? IUsdOrderRouter(o.router).sell(o.token, amt, minOut, o.owner, block.timestamp)
                : IUsdOrderCurve(o.curve).sell(amt, minOut, o.owner);
            t.forceApprove(spender, 0);
            if (out < minOut || out > maxOut) revert OutsideWindow(out, minOut, maxOut);
            emit Executed(id, o.owner, o.curve, false, amt, out);
        }
    }

    // ------------------------------------------------------------ reading

    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ordersOf[owner];
    }

    function _pay(address to, uint256 amount) private {
        usdc.safeTransfer(to, amount);
    }
}
