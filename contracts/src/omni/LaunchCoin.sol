// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";

/**
 * @title LaunchCoin (v6, omnichain): the contract every coin launched on sasa uses
 * @notice One coin, the same address on every chain (deployed by the factory with
 * CREATE3), moved between chains with LayerZero (OFT: burn here, mint there).
 *
 * Rules, all fixed once the factory hands the coin over:
 * - At most 1,000,000,000 coins exist on this chain (checked on every mint). Coins
 *   only appear on a chain by a curve buy, the graduation pool, or arriving from a
 *   chain where the same amount was burned, so the total over all chains stays
 *   within the cap too.
 * - Only the coin's controller (its curve / graduation hub on this chain) can mint.
 * - Before graduation nothing can leave this chain: each chain's curve races on
 *   its own. The controller opens the bridge after graduation and names the
 *   winning chain.
 * - After graduation anyone may move a plain account's coins to the winning chain,
 *   ALWAYS to the same address. Contract wallets (Safe, exchanges, pools) are never
 *   moved for them: the same address on another chain may not be theirs. They can
 *   still send their own coins with the normal OFT `send`.
 * - Optional creator lock (at most 1 day, chosen at launch): until it ends the creator's
 *   coins cannot be sold, sent or bridged anywhere. Buying more is allowed, and the
 *   graduation move (always to the creator's own address) still works.
 * - `setup_` (the factory; deployed through CREATE3 the constructor's caller is a proxy)
 *   holds the owner rights only during launch.
 * - Owner rights (peers, endpoint settings) exist only while the factory sets the
 *   coin up in the launch transaction; the factory then gives them up for good.
 */
interface ICoinCurveHub {
    function hub() external view returns (address);
}

interface IHubKeeperView {
    function keeper() external view returns (address);
}

contract LaunchCoin is OFT {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    /// @notice First word of a batch-move message. Normal OFT messages start with a
    /// left-padded EVM address (12 zero bytes), so they can never match it.
    bytes32 public constant MOVE_BATCH = keccak256("sasa.v6.moveBatch");
    uint256 public constant MAX_BATCH = 200;
    uint16 public constant MAX_MOVE_FEE_BPS = 50; // 0.5% ceiling, fixed
    uint256 public constant MAX_LOCK = 1 days;

    /// @notice The coin's creator and the end of their lock (0: no lock).
    address public immutable creator;
    uint256 public immutable lockedUntil;

    /// @notice Share of moved coins kept as the moving fee (paid to the treasury on arrival).
    uint16 public immutable moveFeeBps;
    /// @notice Receives the moving fee on the winning chain (sasa's fee splitter).
    address public immutable treasury;

    /// @notice The curve / graduation hub of this coin on this chain. Set once.
    address public controller;
    /// @notice True once the coin graduated: cross-chain moves are open.
    bool public bridgeOpen;
    /// @notice LayerZero endpoint id of the winning chain (0 until graduation).
    uint32 public homeEid;
    /// @notice When the bridge opened (graduation). For the first PUBLIC_MOVE_AFTER only
    /// sasa's keeper (and each holder for themselves) may move coins to the winning chain.
    uint64 public bridgeOpenedAt;
    uint256 public constant PUBLIC_MOVE_AFTER = 24 hours;

    event ControllerSet(address controller);
    event BridgeOpened(uint32 homeEid);
    event Moved(address indexed holder, uint256 amount, uint256 fee);
    event MoveArrived(uint32 indexed srcEid, uint256 holders, uint256 total);

    error NotController();
    error AlreadySet();
    error BridgeClosed();
    error OverCap();
    error NotPlainAccount(address who);
    error NotLosingChain();
    error BadBatch();
    error BadFee();
    error MoveNotOpenYet();
    error CreatorLocked(uint256 until);

    constructor(
        string memory name_,
        string memory symbol_,
        address endpoint_,
        uint16 moveFeeBps_,
        address treasury_,
        address creator_,
        uint256 lockSeconds,
        address setup_
    ) OFT(name_, symbol_, endpoint_, setup_) Ownable(setup_) {
        if (moveFeeBps_ > MAX_MOVE_FEE_BPS || treasury_ == address(0)) revert BadFee();
        if (lockSeconds > MAX_LOCK || creator_ == address(0)) revert BadFee();
        moveFeeBps = moveFeeBps_;
        treasury = treasury_;
        creator = creator_;
        lockedUntil = lockSeconds == 0 ? 0 : block.timestamp + lockSeconds;
    }

    /// @notice True while the creator's coins cannot move.
    function isLocked() public view returns (bool) {
        return block.timestamp < lockedUntil;
    }

    /// @dev The lock stops every transfer out of the creator's wallet. Burns are left
    /// alone: the curve never burns from the creator, and the graduation move burns
    /// here only to mint the same amount to the same address on the winning chain.
    function _update(address from, address to, uint256 value) internal override {
        if (from == creator && to != address(0) && isLocked()) revert CreatorLocked(lockedUntil);
        super._update(from, to, value);
    }

    // ------------------------------------------------------------------ setup

    /// @notice One-time link to the coin's controller. Called by the factory before it gives up ownership.
    function setController(address c) external onlyOwner {
        if (controller != address(0) || c == address(0)) revert AlreadySet();
        controller = c;
        emit ControllerSet(c);
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    // ------------------------------------------------------------------ controller

    function mint(address to, uint256 amount) external onlyController {
        _mintCapped(to, amount);
    }

    /// @notice Opens cross-chain moves after graduation and names the winning chain. Once only.
    function openBridge(uint32 winnerEid) external onlyController {
        if (bridgeOpen || winnerEid == 0) revert AlreadySet();
        bridgeOpen = true;
        homeEid = winnerEid;
        bridgeOpenedAt = uint64(block.timestamp);
        emit BridgeOpened(winnerEid);
    }

    /// @notice Anyone may burn their own coins (curves burn what they buy back; unsold coins at graduation).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ moving to the winning chain

    /// @notice True for accounts whose address is theirs on every chain: no code, or an
    /// EIP-7702 delegated account (code = 0xef0100 ++ 20-byte address).
    function isPlainAccount(address a) public view returns (bool) {
        uint256 len = a.code.length;
        if (len == 0) return true;
        if (len != 23) return false;
        bytes memory c = a.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    /// @notice Moves these holders' coins to the winning chain, each to its own address,
    /// in one LayerZero message. Anyone may call it (sasa's keeper does, right after
    /// graduation); the caller pays the LayerZero fee in `msg.value`.
    /// Holders that are not plain accounts make the whole call revert; zero balances are skipped.
    function moveBatch(address[] calldata holders, bytes calldata options)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        // First day after graduation: only sasa's keeper moves other people's coins
        // (anyone else could otherwise move a holder at a moment they didn't choose).
        // After that anyone may, so coins never stay stuck if the keeper stops.
        if (!bridgeOpen) revert BridgeClosed();
        if (homeEid == endpoint.eid()) revert NotLosingChain();
        if (block.timestamp < uint256(bridgeOpenedAt) + PUBLIC_MOVE_AFTER && msg.sender != _keeper()) revert MoveNotOpenYet();
        return _moveBatch(holders, options);
    }

    /// @notice A holder moves their own coins to the winning chain (same address), any time
    /// after graduation. The caller pays the LayerZero fee in `msg.value`.
    function moveSelf(bytes calldata options) external payable returns (MessagingReceipt memory receipt) {
        address[] memory one = new address[](1);
        one[0] = msg.sender;
        return _moveBatch(one, options);
    }

    /// @dev sasa's keeper, read from this coin's curve and its hub (no admin on the coin itself).
    function _keeper() internal view returns (address k) {
        if (controller.code.length == 0) return address(0);
        try ICoinCurveHub(controller).hub() returns (address h) {
            if (h.code.length == 0) return address(0);
            try IHubKeeperView(h).keeper() returns (address kk) {
                k = kk;
            } catch {}
        } catch {}
    }

    function _moveBatch(address[] memory holders, bytes calldata options) internal returns (MessagingReceipt memory receipt) {
        if (!bridgeOpen) revert BridgeClosed();
        uint32 dst = homeEid;
        if (dst == endpoint.eid()) revert NotLosingChain();
        uint256 n = holders.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatch();

        address[] memory to = new address[](n);
        uint64[] memory amountsSD = new uint64[](n);
        uint256 feeTotal;
        uint256 count;
        for (uint256 i; i < n; ++i) {
            address h = holders[i];
            if (!isPlainAccount(h)) revert NotPlainAccount(h);
            uint256 bal = _removeDust(balanceOf(h));
            if (bal == 0) continue;
            _burn(h, bal);
            uint256 fee = _removeDust((bal * moveFeeBps) / 10_000);
            to[count] = h;
            amountsSD[count] = _toSD(bal - fee);
            feeTotal += fee;
            ++count;
            emit Moved(h, bal - fee, fee);
        }
        if (count == 0) revert BadBatch();
        assembly {
            mstore(to, count)
            mstore(amountsSD, count)
        }
        bytes memory message = abi.encode(MOVE_BATCH, to, amountsSD, _toSD(feeTotal));
        // Options carry the gas the destination needs for `count` mints; checked against enforced options.
        receipt = _lzSend(dst, message, combineOptions(dst, SEND, options), MessagingFee(msg.value, 0), payable(msg.sender));
    }

    /// @notice LayerZero fee for a batch of `count` holders (the message size depends only on the count).
    function quoteMoveBatch(uint256 count, bytes calldata options) external view returns (MessagingFee memory) {
        address[] memory to = new address[](count);
        uint64[] memory a = new uint64[](count);
        bytes memory message = abi.encode(MOVE_BATCH, to, a, uint64(0));
        return _quote(homeEid, message, combineOptions(homeEid, SEND, options), false);
    }

    // ------------------------------------------------------------------ OFT hooks

    function _debit(address from, uint256 amountLD, uint256 minAmountLD, uint32 dstEid)
        internal
        override
        returns (uint256 amountSentLD, uint256 amountReceivedLD)
    {
        if (!bridgeOpen) revert BridgeClosed();
        // A normal send may go to any address, so a locked creator cannot use it.
        if (from == creator && isLocked()) revert CreatorLocked(lockedUntil);
        return super._debit(from, amountLD, minAmountLD, dstEid);
    }

    function _credit(address to, uint256 amountLD, uint32 srcEid) internal override returns (uint256) {
        if (to == address(0)) to = address(0xdead);
        _mintCapped(to, amountLD);
        srcEid;
        return amountLD;
    }

    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) internal override {
        if (message.length >= 32 && bytes32(message[0:32]) == MOVE_BATCH) {
            (, address[] memory to, uint64[] memory amountsSD, uint64 feeSD) =
                abi.decode(message, (bytes32, address[], uint64[], uint64));
            if (to.length != amountsSD.length) revert BadBatch();
            uint256 total;
            for (uint256 i; i < to.length; ++i) {
                uint256 amt = _toLD(amountsSD[i]);
                _mintCapped(to[i], amt);
                total += amt;
            }
            if (feeSD > 0) _mintCapped(treasury, _toLD(feeSD));
            emit MoveArrived(origin.srcEid, to.length, total);
            return;
        }
        super._lzReceive(origin, guid, message, executor, extraData);
    }

    function _mintCapped(address to, uint256 amount) internal {
        if (totalSupply() + amount > MAX_SUPPLY) revert OverCap();
        _mint(to, amount);
    }
}
