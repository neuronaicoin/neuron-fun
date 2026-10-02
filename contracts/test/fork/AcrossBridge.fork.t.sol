// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";

contract MigratorProbe {
    bytes32 public coin; uint256 public amount; bool public buyback;
    function receiveConsolidated(bytes32 c, uint256 a, bool b) external { coin = c; amount = a; buyback = b; }
}

/**
 * The Across adapter against the real mainnet contracts:
 * - Base: a real deposit into Across's SpokePool (USDC in, USDG on Robinhood out).
 * - Robinhood: Across's SpokePool delivering USDG to the adapter, which hands it to the migrator.
 * (The relayer's fill between the two happens off-chain; a $5 live test covers it at launch.)
 */
contract AcrossBridgeFork is Test {
    address constant BASE_SPOKE = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant RH_SPOKE = 0xD29C85F15DF544bA632C9E25829fd29d767d7978;
    address constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint32 constant RH_EID = 30416;
    uint32 constant BASE_EID = 30184;
    bytes32 constant COIN = bytes32("cat");
    address consolidator = address(0xC0);
    address safe = address(0x5AFE);

    function test_base_realDepositIntoAcross() public {
        vm.createSelectFork("base");
        AcrossUsdBridge b = new AcrossUsdBridge(IAcrossSpokePool(BASE_SPOKE), IERC20(BASE_USDC), safe);
        uint32[] memory eids = new uint32[](1);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        eids[0] = RH_EID;
        rs[0] = AcrossUsdBridge.Route(4663, RH_USDG, address(0x7777)); // twin: any address for this test
        vm.prank(safe);
        b.setup(consolidator, address(0xDEAD), eids, rs);
        deal(BASE_USDC, consolidator, 100e6);
        vm.startPrank(consolidator);
        IERC20(BASE_USDC).approve(address(b), 100e6);
        uint256 before = IERC20(BASE_USDC).balanceOf(BASE_SPOKE);
        b.send(RH_EID, COIN, 100e6, false, consolidator);
        vm.stopPrank();
        assertEq(IERC20(BASE_USDC).balanceOf(BASE_SPOKE) - before, 100e6, "the SpokePool took the deposit");
        assertEq(IERC20(BASE_USDC).balanceOf(address(b)), 0);
    }

    function test_robinhood_spokePoolDeliversToMigrator() public {
        vm.createSelectFork("robinhood");
        MigratorProbe m = new MigratorProbe();
        AcrossUsdBridge b = new AcrossUsdBridge(IAcrossSpokePool(RH_SPOKE), IERC20(RH_USDG), safe);
        uint32[] memory eids = new uint32[](1);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        eids[0] = BASE_EID;
        rs[0] = AcrossUsdBridge.Route(8453, BASE_USDC, address(0x7777));
        vm.prank(safe);
        b.setup(address(0xC1), address(m), eids, rs);
        // What Across does on a fill with a message: pay the recipient, then call its handler.
        deal(RH_USDG, address(b), 99_900_000);
        vm.prank(RH_SPOKE);
        b.handleV3AcrossMessage(RH_USDG, 99_900_000, address(0xBEEF), abi.encode(COIN, false));
        assertEq(IERC20(RH_USDG).balanceOf(address(m)), 99_900_000);
        assertEq(m.coin(), COIN);
        assertEq(m.amount(), 99_900_000);
    }
}
