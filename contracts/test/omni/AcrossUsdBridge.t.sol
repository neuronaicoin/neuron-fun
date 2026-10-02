// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AcrossUsdBridge, IAcrossSpokePool} from "../../src/omni/AcrossUsdBridge.sol";

contract Dollar is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// Across stand-in: takes deposits, and a test "relayer" fills them on the other side.
contract MockSpoke {
    struct D {
        address depositor; address recipient; address inputToken; address outputToken;
        uint256 inputAmount; uint256 outputAmount; uint256 chainId; uint32 fillDeadlineOffset; bytes message;
    }
    D[] public deposits;
    function depositV3Now(
        address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount,
        uint256 outputAmount, uint256 destinationChainId, address, uint32 fillDeadlineOffset, uint32, bytes calldata message
    ) external payable {
        require(msg.value == 0, "no native");
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        deposits.push(D(depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, fillDeadlineOffset, message));
    }
    function count() external view returns (uint256) { return deposits.length; }
    function last() external view returns (D memory) { return deposits[deposits.length - 1]; }
    /// The relayer pays the recipient and the pool calls its handler (as Across does with a message).
    function fill(Dollar out, address recipient, uint256 amount, bytes calldata message) external {
        out.mint(recipient, amount);
        AcrossUsdBridge(recipient).handleV3AcrossMessage(address(out), amount, address(0xBEEF), message);
    }
    /// Unfilled: Across refunds the depositor.
    function refund(IERC20 t, address to, uint256 amount) external { t.transfer(to, amount); }
}

contract MigratorStub {
    IERC20 public usdc;
    bytes32 public coin; uint256 public amount; bool public buyback; uint256 public calls;
    constructor(IERC20 u) { usdc = u; }
    function receiveConsolidated(bytes32 c, uint256 a, bool b) external {
        require(usdc.balanceOf(address(this)) >= a, "not delivered");
        coin = c; amount = a; buyback = b; calls++;
    }
}

contract AcrossUsdBridgeTest is Test {
    Dollar usdc;   // Base
    Dollar usdg;   // Robinhood
    MockSpoke spokeBase;
    MockSpoke spokeRh;
    AcrossUsdBridge baseBridge;
    AcrossUsdBridge rhBridge;
    MigratorStub rhMigrator;
    address consolidator = address(0xC0);
    address safe = address(0x5AFE);
    uint32 constant RH_EID = 30416;
    uint32 constant BASE_EID = 30184;
    bytes32 constant COIN = bytes32("cat");

    function setUp() public {
        usdc = new Dollar("USDC");
        usdg = new Dollar("USDG");
        spokeBase = new MockSpoke();
        spokeRh = new MockSpoke();
        baseBridge = new AcrossUsdBridge(IAcrossSpokePool(address(spokeBase)), usdc, safe);
        rhBridge = new AcrossUsdBridge(IAcrossSpokePool(address(spokeRh)), usdg, safe);
        rhMigrator = new MigratorStub(usdg);

        uint32[] memory eids = new uint32[](1);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](1);
        eids[0] = RH_EID;
        rs[0] = AcrossUsdBridge.Route(4663, address(usdg), address(rhBridge));
        vm.prank(safe);
        baseBridge.setup(consolidator, address(0xDEAD), eids, rs);
        eids[0] = BASE_EID;
        rs[0] = AcrossUsdBridge.Route(8453, address(usdc), address(baseBridge));
        vm.prank(safe);
        rhBridge.setup(address(0xC1), address(rhMigrator), eids, rs);

        usdc.mint(consolidator, 10_000e6);
        vm.prank(consolidator);
        usdc.approve(address(baseBridge), type(uint256).max);
    }

    function test_send_depositsToTwin_withCappedFee_noNativeFee() public {
        assertEq(baseBridge.quote(RH_EID, 4_000e6), 0);
        vm.deal(consolidator, 1 ether);
        vm.prank(consolidator);
        baseBridge.send{value: 0.01 ether}(RH_EID, COIN, 4_000e6, false, consolidator);
        MockSpoke.D memory d = spokeBase.last();
        assertEq(d.depositor, address(baseBridge));
        assertEq(d.recipient, address(rhBridge));
        assertEq(d.inputToken, address(usdc));
        assertEq(d.outputToken, address(usdg));
        assertEq(d.inputAmount, 4_000e6);
        assertEq(d.outputAmount, 3_996e6); // 0.1%
        assertEq(d.chainId, 4663);
        assertEq(d.fillDeadlineOffset, 4 hours);
        assertEq(abi.decode(d.message, (bytes32)), COIN);
        assertEq(usdc.balanceOf(address(baseBridge)), 0);
        assertEq(consolidator.balance, 1 ether); // native fee refunded
    }

    function test_onlyConsolidatorSends() public {
        vm.expectRevert(AcrossUsdBridge.NotConsolidator.selector);
        baseBridge.send(RH_EID, COIN, 1e6, false, address(this));
    }

    function test_unknownRouteReverts() public {
        vm.prank(consolidator);
        vm.expectRevert(AcrossUsdBridge.UnknownRoute.selector);
        baseBridge.send(999, COIN, 1e6, false, consolidator);
    }

    function test_fill_reachesMigrator_forTheCoin() public {
        vm.prank(consolidator);
        baseBridge.send(RH_EID, COIN, 4_000e6, true, consolidator);
        MockSpoke.D memory d = spokeBase.last();
        spokeRh.fill(usdg, d.recipient, d.outputAmount, d.message);
        assertEq(usdg.balanceOf(address(rhMigrator)), 3_996e6);
        assertEq(rhMigrator.coin(), COIN);
        assertEq(rhMigrator.amount(), 3_996e6);
        assertTrue(rhMigrator.buyback());
    }

    function test_handlerOnlyFromSpokePool_andOnlyItsDollar() public {
        vm.expectRevert(AcrossUsdBridge.NotSpokePool.selector);
        rhBridge.handleV3AcrossMessage(address(usdg), 1e6, address(this), abi.encode(COIN, false));
        vm.prank(address(spokeRh));
        vm.expectRevert(AcrossUsdBridge.WrongToken.selector);
        rhBridge.handleV3AcrossMessage(address(usdc), 1e6, address(this), abi.encode(COIN, false));
    }

    function test_feeCap() public {
        vm.prank(safe);
        vm.expectRevert(AcrossUsdBridge.FeeTooHigh.selector);
        baseBridge.setFeeBps(51);
        vm.prank(safe);
        baseBridge.setFeeBps(50);
        vm.prank(consolidator);
        baseBridge.send(RH_EID, COIN, 1_000e6, false, consolidator);
        assertEq(spokeBase.last().outputAmount, 995e6);
        vm.expectRevert(); // not owner
        baseBridge.setFeeBps(1);
    }

    function test_resend_afterRefund_sameCoinSameChain_once() public {
        vm.prank(consolidator);
        baseBridge.send(RH_EID, COIN, 2_000e6, false, consolidator);
        // Not refunded yet: nothing to resend with.
        vm.prank(safe);
        vm.expectRevert(AcrossUsdBridge.NotRefunded.selector);
        baseBridge.resend(0, 30);
        // Across refunds the unfilled deposit to the bridge.
        spokeBase.refund(usdc, address(baseBridge), 2_000e6);
        vm.expectRevert(); // only the owner
        baseBridge.resend(0, 30);
        vm.prank(safe);
        baseBridge.resend(0, 30);
        MockSpoke.D memory d = spokeBase.last();
        assertEq(d.recipient, address(rhBridge));
        assertEq(abi.decode(d.message, (bytes32)), COIN);
        assertEq(d.outputAmount, 1_994e6);
        vm.prank(safe);
        vm.expectRevert(AcrossUsdBridge.AlreadyResent.selector);
        baseBridge.resend(0, 30);
        vm.prank(safe);
        vm.expectRevert(AcrossUsdBridge.FeeTooHigh.selector);
        baseBridge.resend(1, 51);
    }

    function test_setupLocks() public {
        vm.prank(safe);
        baseBridge.lock();
        uint32[] memory eids = new uint32[](0);
        AcrossUsdBridge.Route[] memory rs = new AcrossUsdBridge.Route[](0);
        vm.prank(safe);
        vm.expectRevert(AcrossUsdBridge.Locked.selector);
        baseBridge.setup(consolidator, address(1), eids, rs);
    }
}
