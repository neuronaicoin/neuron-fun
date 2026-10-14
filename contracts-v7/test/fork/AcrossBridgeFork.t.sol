// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";

/// Sends dollars into the REAL Across SpokePool of a forked chain and checks the deposit is
/// accepted with the amount asked for on arrival in the destination's decimals.
abstract contract AcrossBridgeForkBase is Test {
    // Base
    address constant BASE_SPOKE = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // BNB Chain
    address constant BNB_SPOKE = 0x4e8E101924eDE233C13e2D8622DC8aED2872d505;
    address constant BNB_USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    // Robinhood Chain
    address constant HOOD_SPOKE = 0xD29C85F15DF544bA632C9E25829fd29d767d7978;
    address constant HOOD_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant TWIN = address(0xBEEF);
    uint32 constant DST = 1;

    function _depositInto(address spoke, address usd, uint256 dstChainId, address dstToken, uint8 dstDec, uint256 amount, uint256 expectedOut)
        internal
    {
        AcrossUsdBridge b = new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(usd), address(this));
        uint32[] memory eids = new uint32[](1);
        eids[0] = DST;
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        rs[0] = AcrossUsdBridge.Route(dstChainId, dstToken, TWIN, dstDec);
        b.setup(address(this), address(0x1234), eids, rs);

        deal(usd, address(this), amount);
        IERC20(usd).approve(address(b), amount);
        uint256 spokeBefore = IERC20(usd).balanceOf(spoke);
        vm.expectEmit(true, true, true, true, address(b));
        emit AcrossUsdBridge.Sent_(0, DST, bytes32(uint256(7)), amount, expectedOut, false);
        b.send(DST, bytes32(uint256(7)), amount, false, address(this));
        assertEq(IERC20(usd).balanceOf(spoke) - spokeBefore, amount, "spoke pool did not take the money");
        assertEq(IERC20(usd).balanceOf(address(b)), 0);
    }
}

/// Run with --fork-url base: Base USDC (6) -> BNB Chain USDC (18), and -> Robinhood USDG (6).
contract AcrossBridgeBaseForkTest is AcrossBridgeForkBase {
    function setUp() public {
        if (block.chainid != 8453) vm.skip(true);
    }

    function test_baseToBnb() public {
        _depositInto(BASE_SPOKE, BASE_USDC, 56, BNB_USDC, 18, 1_000e6, 999e18);
    }
}

/// Run with --fork-url robinhood (chain 4663): Robinhood USDG (6) -> Base USDC (6).
contract AcrossBridgeHoodForkTest is AcrossBridgeForkBase {
    function setUp() public {
        if (block.chainid != 4663) vm.skip(true);
    }

    function test_robinhoodToBase() public {
        if (HOOD_SPOKE.code.length == 0) vm.skip(true);
        _depositInto(HOOD_SPOKE, HOOD_USDG, 8453, BASE_USDC, 6, 1_000e6, 999e6);
    }
}
