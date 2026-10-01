// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {LaunchCoin} from "../../src/omni/LaunchCoin.sol";
import {UsdCurveV6} from "../../src/omni/UsdCurveV6.sol";
import {OmniHub} from "../../src/omni/OmniHub.sol";
import {OmniFactory} from "../../src/omni/OmniFactory.sol";
import {OmniCoinDeployer, OmniCurveDeployer} from "../../src/omni/OmniDeployers.sol";
import {MockLzEndpoint} from "./MockLzEndpoint.sol";
import {USDC6, SinkStub} from "./UsdCurveV6.t.sol";

contract OmniFactoryTest is Test {
    uint32 constant A = 60_001;
    uint32 constant B = 60_002;
    MockLzEndpoint ep;
    OmniHub hub;
    OmniFactory f;
    USDC6 usdc;
    address creator = address(0xC4EA);

    function _uln(uint8 n) internal pure returns (bytes memory) {
        address[] memory req = new address[](n);
        for (uint256 i; i < n; ++i) req[i] = address(uint160(0xD000 + i));
        return abi.encode(OmniFactory.UlnConfig(20, n, 0, 0, req, new address[](0)));
    }

    function setUp() public {
        ep = new MockLzEndpoint(A);
        hub = new OmniHub(address(ep), address(this), A, A);
        usdc = new USDC6();
        address sink1 = address(new SinkStub());
        address sink2 = address(new SinkStub());
        // The factory goes right after its two helpers, which are told its address up front.
        address fAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        OmniCoinDeployer cd = new OmniCoinDeployer(fAt);
        OmniCurveDeployer vd = new OmniCurveDeployer(fAt);
        f = new OmniFactory(
            address(this), ILayerZeroEndpointV2(address(ep)), A, IERC20(address(usdc)), address(hub),
            sink1, sink2, address(0x7E), address(0x9407),
            OmniFactory.Config(4_500e6, 1_073_000_000 ether, 10_000e6, 100, 3_000, 10),
            2,
            cd,
            vd
        );
        assertEq(address(f), fAt);
        hub.setFactory(address(f));
        f.setRoute(B, OmniFactory.Route(address(0x5E), address(0x4E), abi.encode(uint32(10_000), address(0xE1)), _uln(2)));
        f.setLaunchesOpen(true);
        usdc.mint(creator, 10_000e6);
        vm.prank(creator);
        usdc.approve(address(f), type(uint256).max);
    }

    function _launch(bytes32 key, uint256 devBuy, uint256 lock) internal returns (address coin, address curve) {
        uint32[] memory eids = new uint32[](2);
        eids[0] = A;
        eids[1] = B;
        vm.prank(creator);
        (coin, curve) = f.launch(
            OmniFactory.Launch("Kedi", "KEDI", "ipfs://x", "a cat", key, eids, lock, UsdCurveV6.FeeMode.Creator, devBuy, 0)
        );
    }

    function test_launch_sameAddressAndLocked() public {
        address predicted = f.coinAddress(creator, "k1");
        (address coin, address curve) = _launch("k1", 0, 0);
        assertEq(coin, predicted, "CREATE3 address = predicted (same on every chain)");
        LaunchCoin c = LaunchCoin(coin);
        assertEq(c.owner(), address(0), "ownership gone");
        assertEq(ep.delegates(coin), f.DEAD(), "endpoint settings locked");
        assertEq(c.peers(B), bytes32(uint256(uint160(coin))), "twin on chain B = same address");
        assertEq(ep.sendLib(coin, B), address(0x5E));
        assertEq(ep.receiveLib(coin, B), address(0x4E));
        assertEq(ep.configCalls(coin), 2);
        assertEq(c.controller(), curve);
        assertEq(c.creator(), creator);
        (address hc, uint256 target,, uint32[] memory eids) = hub.localOf(f.coinIdOf(creator, "k1"));
        assertEq(hc, curve);
        assertEq(target, 10_000e6);
        assertEq(eids.length, 2);
        // Scaled to 1/2 of the reference curve.
        assertEq(UsdCurveV6(curve).initialVirtualNative(), 2_250e6);
        assertEq(UsdCurveV6(curve).saleCap(), f.saleCapFor(2));
    }

    function test_devBuyFirst_withLock() public {
        (address coin,) = _launch("k2", 500e6, 1 hours);
        assertGt(IERC20(coin).balanceOf(creator), 0);
        assertEq(usdc.balanceOf(address(f)), 0);
        vm.prank(creator);
        vm.expectRevert();
        IERC20(coin).transfer(address(1), 1);
    }

    function test_sameKeyTwiceFails() public {
        _launch("k3", 0, 0);
        vm.expectRevert();
        _launch("k3", 0, 0);
    }

    function test_routeNeedsTwoVerifiers() public {
        vm.expectRevert(OmniFactory.TooFewVerifiers.selector);
        f.setRoute(B, OmniFactory.Route(address(0x5E), address(0x4E), "", _uln(1)));
    }

    function test_unknownChainRefused() public {
        uint32[] memory eids = new uint32[](2);
        eids[0] = A;
        eids[1] = 60_099;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(OmniFactory.NoRoute.selector, uint32(60_099)));
        f.launch(OmniFactory.Launch("K", "K", "", "", "k4", eids, 0, UsdCurveV6.FeeMode.Creator, 0, 0));
    }

    function test_closedAndOwnerCannotRenounce() public {
        f.setLaunchesOpen(false);
        vm.expectRevert(OmniFactory.LaunchesClosed.selector);
        _launch("k5", 0, 0);
        vm.expectRevert(OmniFactory.RenounceDisabled.selector);
        f.renounceOwnership();
    }

    function test_configKeepsSupplyUnderCap() public {
        // A target so large that one chain could sell more than 1B with the pool: refused.
        vm.expectRevert(OmniFactory.BadConfig.selector);
        f.setConfig(OmniFactory.Config(4_500e6, 1_073_000_000 ether, 10_000_000e6, 100, 3_000, 10));
    }
}
