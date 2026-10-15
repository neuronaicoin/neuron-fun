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
        rs[0] = AcrossUsdBridge.Route(dstChainId, dstToken, TWIN, dstDec, false);
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

    uint32 constant MID = 2;
    uint32 constant FINAL = 3;
    address constant KEEPER = address(0xBEE);

    /// First leg of a two-step route: the money leaves for the middle chain's bridge, the
    /// message naming the final chain.
    function _hopFirstLeg(address spoke, address usd, uint256 midChainId, address midToken, uint8 midDec, uint256 amount, uint256 expectedOut)
        internal
    {
        AcrossUsdBridge b = new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(usd), address(this));
        uint32[] memory eids = new uint32[](2);
        (eids[0], eids[1]) = (MID, FINAL);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](2);
        rs[0] = AcrossUsdBridge.Route(midChainId, midToken, TWIN, midDec, false);
        rs[1] = AcrossUsdBridge.Route(midChainId, midToken, TWIN, midDec, true);
        b.setup(address(this), address(0x1234), eids, rs);

        deal(usd, address(this), amount);
        IERC20(usd).approve(address(b), amount);
        uint256 spokeBefore = IERC20(usd).balanceOf(spoke);
        vm.expectEmit(true, true, true, true, address(b));
        emit AcrossUsdBridge.Sent_(0, FINAL, bytes32(uint256(7)), amount, expectedOut, false);
        b.send(FINAL, bytes32(uint256(7)), amount, false, address(this));
        assertEq(IERC20(usd).balanceOf(spoke) - spokeBefore, amount, "spoke pool did not take the money");
        assertEq(IERC20(usd).balanceOf(address(b)), 0);
    }

    /// Second leg on the middle chain: the real SpokePool delivers the hop, then anyone
    /// forwards it into the real SpokePool towards the final chain.
    function _hopSecondLeg(address spoke, address usd, uint256 finalChainId, address finalToken, uint8 finalDec, uint256 amount, uint256 tip, uint256 expectedOut)
        internal
    {
        AcrossUsdBridge b = new AcrossUsdBridge(IAcrossSpokePool(spoke), IERC20(usd), address(this));
        uint32[] memory eids = new uint32[](1);
        eids[0] = FINAL;
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        rs[0] = AcrossUsdBridge.Route(finalChainId, finalToken, TWIN, finalDec, false);
        b.setup(address(this), address(0x1234), eids, rs);

        // what Across's relayer does: pay the bridge, then the SpokePool calls it
        deal(usd, address(b), amount);
        vm.prank(spoke);
        b.handleV3AcrossMessage(usd, amount, address(0xF111), abi.encode(bytes32(uint256(7)), false, FINAL));
        assertEq(b.hopsCount(), 1);

        uint256 spokeBefore = IERC20(usd).balanceOf(spoke);
        vm.expectEmit(true, true, true, true, address(b));
        emit AcrossUsdBridge.Sent_(0, FINAL, bytes32(uint256(7)), amount - tip, expectedOut, false);
        vm.prank(KEEPER);
        b.forwardHop(0);
        assertEq(IERC20(usd).balanceOf(KEEPER), tip, "keeper tip");
        assertEq(IERC20(usd).balanceOf(spoke) - spokeBefore, amount - tip, "spoke pool did not take the money");
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

    /// Base as the middle of BNB Chain -> Robinhood Chain: forward to Robinhood USDG.
    function test_hopForwardToRobinhood() public {
        // $999 landed, 5 cents tip, 0.1% fee on the rest
        _hopSecondLeg(BASE_SPOKE, BASE_USDC, 4663, HOOD_USDG, 6, 999e6, 0.05e6, (uint256(998.95e6) * 9_990) / 10_000);
    }

    /// Base as the middle of Robinhood Chain -> BNB Chain: forward to BNB Chain USDC (18 decimals).
    function test_hopForwardToBnb() public {
        _hopSecondLeg(BASE_SPOKE, BASE_USDC, 56, BNB_USDC, 18, 999e6, 0.05e6, ((uint256(998.95e6) * 9_990) / 10_000) * 1e12);
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

    /// First leg of Robinhood Chain -> BNB Chain: to Base, where it is forwarded.
    function test_hopRobinhoodToBnbFirstLeg() public {
        if (HOOD_SPOKE.code.length == 0) vm.skip(true);
        _hopFirstLeg(HOOD_SPOKE, HOOD_USDG, 8453, BASE_USDC, 6, 1_000e6, 999e6);
    }
}
