// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SasaV3Launcher, IV3PositionManager, IWrappedNative} from "../src/SasaV3Launcher.sol";
import {SasaCoin} from "../src/SasaCoin.sol";

/// WETH9-style wrapped HYPE for the tests.
contract MockWrapped {
    string public name = "Wrapped HYPE";
    string public symbol = "WHYPE";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 w) external {
        balanceOf[msg.sender] -= w;
        payable(msg.sender).transfer(w);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address s, uint256 w) external returns (bool) {
        allowance[msg.sender][s] = w;
        return true;
    }

    function transfer(address d, uint256 w) external returns (bool) {
        return transferFrom(msg.sender, d, w);
    }

    function transferFrom(address s, address d, uint256 w) public returns (bool) {
        require(balanceOf[s] >= w, "bal");
        if (s != msg.sender && allowance[s][msg.sender] != type(uint256).max) {
            require(allowance[s][msg.sender] >= w, "allow");
            allowance[s][msg.sender] -= w;
        }
        balanceOf[s] -= w;
        balanceOf[d] += w;
        return true;
    }

    receive() external payable {
        deposit();
    }
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface INpmView {
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

interface IV3PoolView {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

contract SasaV3LauncherTest is Test {
    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address creator = address(0xC0FFEE);
    address trader = address(0xBEEF);

    MockWrapped whype;
    address factory;
    address npm;
    address router;
    SasaV3Launcher launcher;

    uint256 constant START_MC = 100 ether; // 100 HYPE for the whole supply

    function _setUp(address whypeAt) internal {
        deployCodeTo("SasaV3Launcher.t.sol:MockWrapped", whypeAt);
        whype = MockWrapped(payable(whypeAt));
        factory = deployCode("v3/UniswapV3Factory.json");
        npm = deployCode("v3/NonfungiblePositionManager.json", abi.encode(factory, whypeAt, address(0)));
        router = deployCode("v3/SwapRouter.json", abi.encode(factory, whypeAt));
        launcher = new SasaV3Launcher(
            owner, IV3PositionManager(npm), IWrappedNative(whypeAt), 10_000, 200, treasury, START_MC, 3_000
        );
        vm.deal(creator, 1_000 ether);
        vm.deal(trader, 1_000 ether);
    }

    // WHYPE at a high address: every coin is token0. At a low address: every coin is token1.
    function setUp() public virtual {
        _setUp(address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF));
    }

    function _launch(uint256 firstBuy) internal returns (address coin, uint256 bought) {
        vm.prank(creator);
        (coin, bought) = launcher.launch{value: firstBuy}("Elysium Cat", "ECAT", "https://sasapad.fun/s/x", address(0), 0);
    }

    function _buy(address coin, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(trader);
        whype.deposit{value: amount}();
        whype.approve(router, amount);
        out = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams(address(whype), coin, 10_000, trader, block.timestamp, amount, 0, 0)
        );
        vm.stopPrank();
    }

    function _sell(address coin, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(trader);
        IERC20(coin).approve(router, amount);
        out = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams(coin, address(whype), 10_000, trader, block.timestamp, amount, 0, 0)
        );
        vm.stopPrank();
    }

    function _checkLaunch(address coin, uint256 bought, uint256 firstBuy) internal view {
        (uint256 tokenId, address pool, address cr, uint16 bps,) = launcher.coins(coin);
        assertEq(cr, creator);
        assertEq(bps, 3_000);
        // the whole supply is in the pool or with the first buyer; nothing left in the launcher
        assertEq(IERC20(coin).balanceOf(address(launcher)), 0);
        assertEq(IERC20(coin).balanceOf(creator), bought);
        assertApproxEqAbs(IERC20(coin).balanceOf(pool) + bought, 1_000_000_000 ether, 1e12);
        // the position is locked in the launcher
        assertEq(IERC721(npm).ownerOf(tokenId), address(launcher));
        (,,,,,,, uint128 liq,,,,) = INpmView(npm).positions(tokenId);
        assertGt(liq, 0);
        if (firstBuy > 0) {
            assertGt(bought, 0);
            assertEq(whype.balanceOf(pool), firstBuy);
        }
        assertEq(SasaCoin(coin).creator(), creator);
    }

    function test_launchNoBuy() public {
        (address coin, uint256 bought) = _launch(0);
        assertEq(bought, 0);
        _checkLaunch(coin, 0, 0);
    }

    function test_launchWithFirstBuy_startPrice() public {
        (address coin, uint256 bought) = _launch(1 ether);
        _checkLaunch(coin, bought, 1 ether);
        // 1 HYPE at a 100 HYPE start market cap buys a bit under 1% of supply (fee + curve)
        assertGt(bought, 9_000_000 ether);
        assertLt(bought, 10_000_000 ether);
    }

    function test_tradesAndFeeSplit() public {
        (address coin,) = _launch(1 ether);
        uint256 got = _buy(coin, 10 ether);
        assertGt(got, 0);
        uint256 back = _sell(coin, got);
        assertGt(back, 0);
        assertLt(back, 10 ether); // fee + price impact
        uint256 tBefore = whype.balanceOf(treasury);
        uint256 cBefore = whype.balanceOf(creator);
        (uint256 coinFees, uint256 nativeFees) = launcher.collect(coin);
        // 1% of 1 + 10 HYPE bought in native, 1% of the sold coins in coin
        assertApproxEqAbs(nativeFees, 0.11 ether, 0.001 ether);
        assertGt(coinFees, 0);
        uint256 toCreator = whype.balanceOf(creator) - cBefore;
        uint256 toTreasury = whype.balanceOf(treasury) - tBefore;
        assertEq(toCreator + toTreasury, nativeFees);
        assertEq(toCreator, (nativeFees * 3_000) / 10_000);
        assertGt(IERC20(coin).balanceOf(treasury), 0);
        // collecting again gives nothing new
        (uint256 c2, uint256 n2) = launcher.collect(coin);
        assertEq(c2 + n2, 0);
    }

    function test_creatorCanAlwaysSellBack() public {
        (address coin, uint256 bought) = _launch(5 ether);
        vm.prank(creator);
        IERC20(coin).transfer(trader, bought);
        uint256 back = _sell(coin, bought);
        // gets most of it back (two 1% fees, nobody else traded)
        assertGt(back, 4.85 ether);
    }

    function test_minOutProtects() public {
        vm.prank(creator);
        vm.expectRevert(SasaV3Launcher.TooLittleOut.selector);
        launcher.launch{value: 1 ether}("A", "A", "", address(0), 1_000_000_000 ether);
    }

    function test_launchFeeAndSettings() public {
        vm.prank(owner);
        launcher.setSettings(treasury, START_MC, 5_000, 0.01 ether, false);
        vm.prank(creator);
        vm.expectRevert(SasaV3Launcher.FeeNotPaid.selector);
        launcher.launch{value: 0.001 ether}("A", "A", "", address(0), 0);
        uint256 before = treasury.balance;
        vm.prank(creator);
        (address coin, uint256 bought) = launcher.launch{value: 0.51 ether}("A", "A", "", address(0), 0);
        assertEq(treasury.balance - before, 0.01 ether);
        assertGt(bought, 0);
        (,,, uint16 bps,) = launcher.coins(coin);
        assertEq(bps, 5_000);
        // only the owner changes settings, and the creator share is capped
        vm.expectRevert();
        launcher.setSettings(treasury, START_MC, 3_000, 0, false);
        vm.prank(owner);
        vm.expectRevert(SasaV3Launcher.BadSettings.selector);
        launcher.setSettings(treasury, START_MC, 6_000, 0, false);
        vm.prank(owner);
        launcher.setSettings(treasury, START_MC, 3_000, 0, true);
        vm.prank(creator);
        vm.expectRevert(SasaV3Launcher.Paused.selector);
        launcher.launch("A", "A", "", address(0), 0);
    }

    function test_launchForAnotherCreator() public {
        vm.prank(trader);
        (address coin, uint256 bought) = launcher.launch{value: 1 ether}("A", "A", "", creator, 0);
        assertEq(IERC20(coin).balanceOf(creator), bought);
        (,, address cr,,) = launcher.coins(coin);
        assertEq(cr, creator);
    }

    function test_callbackOnlyFromActivePool() public {
        vm.expectRevert(SasaV3Launcher.BadCallback.selector);
        launcher.uniswapV3SwapCallback(1, 0, "");
    }

    function testFuzz_firstBuy(uint96 amount) public {
        uint256 a = bound(uint256(amount), 0, 500 ether);
        if (a < 1e9) a = 0; // a few wei buy nothing after the 1% fee
        (address coin, uint256 bought) = _launch(a);
        _checkLaunch(coin, bought, a);
    }

    function testFuzz_startMc(uint96 mc) public {
        uint256 m = bound(uint256(mc), 1e15, 1e27);
        vm.prank(owner);
        launcher.setSettings(treasury, m, 3_000, 0, false);
        uint256 buy = m / 100 > 100 ether ? 100 ether : m / 100;
        (address coin, uint256 bought) = _launch(buy);
        _checkLaunch(coin, bought, buy);
    }
}

/// The same tests with the coin as token1 (WHYPE at a low address).
contract SasaV3LauncherToken1Test is SasaV3LauncherTest {
    function setUp() public override {
        _setUp(address(0x0000000000000000000000000000000000001234));
    }
}
