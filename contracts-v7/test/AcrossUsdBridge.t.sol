// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../src/omni/AcrossUsdBridge.sol";

contract DecUsd is ERC20 {
    uint8 private immutable d;
    constructor(uint8 d_) ERC20("Dollar", "USD") { d = d_; }
    function decimals() public view override returns (uint8) { return d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// Records the last deposit and keeps the money, like the real SpokePool.
contract MockSpoke is IAcrossSpokePool {
    address public inputToken;
    address public outputToken;
    uint256 public inputAmount;
    uint256 public outputAmount;
    uint256 public dstChainId;
    address public recipient;

    function depositV3Now(address, address recipient_, address inputToken_, address outputToken_, uint256 inputAmount_, uint256 outputAmount_, uint256 dst, address, uint32, uint32, bytes calldata)
        external
        payable
    {
        IERC20(inputToken_).transferFrom(msg.sender, address(this), inputAmount_);
        (inputToken, outputToken, inputAmount, outputAmount, dstChainId, recipient) = (inputToken_, outputToken_, inputAmount_, outputAmount_, dst, recipient_);
    }

    function refund(address to, uint256 a) external {
        IERC20(inputToken).transfer(to, a);
    }
}

/// The bridge asks for the right amount in the destination's decimals.
contract AcrossUsdBridgeTest is Test {
    uint32 constant BASE = 30184;
    uint32 constant BNB = 30102;
    uint32 constant HOOD = 30416;
    address constant TWIN = address(0xBEEF);
    address constant OUT_TOKEN = address(0xCAFE);

    function _bridge(uint8 dec) internal returns (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) {
        usd = new DecUsd(dec);
        spoke = new MockSpoke();
        b = new AcrossUsdBridge(spoke, IERC20(address(usd)), address(this));
        uint32[] memory eids = new uint32[](3);
        (eids[0], eids[1], eids[2]) = (BASE, BNB, HOOD);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](3);
        rs[0] = AcrossUsdBridge.Route(8453, OUT_TOKEN, TWIN, 6, false);
        rs[1] = AcrossUsdBridge.Route(56, OUT_TOKEN, TWIN, 18, false);
        rs[2] = AcrossUsdBridge.Route(4663, OUT_TOKEN, TWIN, 6, false);
        b.setup(address(this), address(0x1234), eids, rs);
    }

    function _send(AcrossUsdBridge b, DecUsd usd, uint32 dst, uint256 amount) internal {
        usd.mint(address(this), amount);
        usd.approve(address(b), amount);
        b.send(dst, bytes32(uint256(7)), amount, false, address(this));
    }

    function test_decimalsReadFromToken() public {
        (AcrossUsdBridge b6,,) = _bridge(6);
        (AcrossUsdBridge b18,,) = _bridge(18);
        assertEq(b6.tokenDecimals(), 6);
        assertEq(b18.tokenDecimals(), 18);
    }

    function test_baseToBnb_scalesUp() public {
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(6);
        _send(b, usd, BNB, 1_000e6); // $1,000 on Base
        assertEq(spoke.inputAmount(), 1_000e6);
        assertEq(spoke.outputAmount(), 999e18); // $999 on BNB Chain (0.1% fee)
        assertEq(spoke.dstChainId(), 56);
    }

    function test_bnbToBase_scalesDown() public {
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(18);
        _send(b, usd, BASE, 1_000e18);
        assertEq(spoke.inputAmount(), 1_000e18);
        assertEq(spoke.outputAmount(), 999e6);
        assertEq(spoke.dstChainId(), 8453);
    }

    function test_sameDecimals_unchanged() public {
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(6);
        _send(b, usd, HOOD, 1_000e6);
        assertEq(spoke.outputAmount(), 999e6);
    }

    /// Under one millionth of a dollar: no deposit, no revert (the rest of the move goes on).
    function test_dustBelowOneUnit_staysWithoutReverting() public {
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(18);
        _send(b, usd, BASE, 1e11);
        assertEq(spoke.inputAmount(), 0);
        assertEq(usd.balanceOf(address(b)), 1e11);
        assertEq(b.sendsCount(), 1);
    }

    function test_resendConverts() public {
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(18);
        _send(b, usd, BASE, 500e18);
        spoke.refund(address(b), 500e18); // Across refunds an unfilled deposit
        b.resend(0, 50);
        assertEq(spoke.inputAmount(), 500e18);
        assertEq(spoke.outputAmount(), 497.5e6); // 0.5% fee
    }

    function test_setupRejectsZeroDecimals() public {
        DecUsd usd = new DecUsd(6);
        AcrossUsdBridge b = new AcrossUsdBridge(new MockSpoke(), IERC20(address(usd)), address(this));
        uint32[] memory eids = new uint32[](1);
        eids[0] = BNB;
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        rs[0] = AcrossUsdBridge.Route(56, OUT_TOKEN, TWIN, 0, false);
        vm.expectRevert(AcrossUsdBridge.BadAddress.selector);
        b.setup(address(this), address(1), eids, rs);
    }

    /// Whatever the amount and fee, the dollar value asked for never exceeds what was sent
    /// and is short of it by at most the fee plus one smallest unit.
    function testFuzz_valueKept(uint256 amount, uint256 bps, bool fromBnb) public {
        bps = bound(bps, 0, 50);
        (AcrossUsdBridge b, DecUsd usd, MockSpoke spoke) = _bridge(fromBnb ? 18 : 6);
        b.setFeeBps(bps);
        if (fromBnb) {
            amount = bound(amount, 1e12, 1e30);
            _send(b, usd, BASE, amount);
            uint256 asked = spoke.outputAmount() * 1e12; // back in 18 decimals
            assertLe(asked, amount);
            assertGe(asked + 1e12, (amount * (10_000 - bps)) / 10_000);
        } else {
            amount = bound(amount, 1_000, 1e18);
            _send(b, usd, BNB, amount);
            assertEq(spoke.outputAmount(), ((amount * (10_000 - bps)) / 10_000) * 1e12);
        }
    }
}
