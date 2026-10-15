// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAcrossSpokePool} from "../src/omni/AcrossUsdBridge.sol";
import {RaceCross, RaceCrossUsdc, IRaceRouter} from "../src/race/RaceCross.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {DecUsd} from "./AcrossUsdBridge.t.sol";

interface IAcrossReceiver {
    function handleV3AcrossMessage(address token, uint256 amount, address relayer, bytes memory message) external;
}

/// One chain's Across SpokePool: `fill` plays the relayer; deposits are recorded.
contract XSpoke is IAcrossSpokePool {
    struct Dep {
        address depositor;
        address recipient;
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 dstChainId;
    }

    Dep public last;
    uint256 public count;

    function depositV3Now(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 dst, address, uint32, uint32, bytes calldata)
        external
        payable
    {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        last = Dep(depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, dst);
        count++;
    }

    function fill(DecUsd token, address to, uint256 amount, bytes calldata message) external {
        token.mint(to, amount);
        IAcrossReceiver(to).handleV3AcrossMessage(address(token), amount, address(0xF111), message);
    }
}

contract MockCoin is DecUsd(18) {}

/// Buys 1 coin per dollar unit; sells 1 dollar unit per coin. Can be told to fail.
contract MockRouter is IRaceRouter {
    DecUsd public immutable usd;
    MockCoin public immutable coinT;
    bool public broken;
    bool public halfOnly; // uses only half of what it is given (like a pool hitting its price limit)
    bool public hungry; // burns all the gas it gets

    constructor(DecUsd u, MockCoin c) {
        usd = u;
        coinT = c;
    }

    function breakIt(bool b) external {
        broken = b;
    }

    function setPartial(bool b) external {
        halfOnly = b;
    }

    function setHungry(bool b) external {
        hungry = b;
    }

    function buy(address coin, uint256 usdcIn, uint256 minOut, address to, uint256 deadline) external returns (uint256) {
        require(!broken && block.timestamp <= deadline, "nope");
        require(coin == address(coinT), "coin");
        if (hungry) while (true) {}
        if (halfOnly) usdcIn /= 2;
        usd.transferFrom(msg.sender, address(this), usdcIn);
        require(usdcIn >= minOut, "slippage");
        coinT.mint(to, usdcIn);
        return usdcIn;
    }

    function sell(address coin, uint256 coinsIn, uint256 minOut, address to, uint256 deadline) external returns (uint256) {
        require(!broken && block.timestamp <= deadline, "nope");
        require(coin == address(coinT), "coin");
        if (halfOnly) coinsIn /= 2;
        coinT.transferFrom(msg.sender, address(this), coinsIn);
        require(coinsIn >= minOut, "slippage");
        usd.mint(to, coinsIn);
        return coinsIn;
    }
}

/// The shared logic, on the Arc variant (gas = dollars): delivery, refund, top-up rules, going home.
contract RaceCrossTest is Test {
    uint256 constant BASE = 8453;
    address constant BASE_USDC = address(0xBA5E);
    address user = address(0xA11CE);

    function _setup(uint8 dec) internal returns (RaceCrossUsdc x, DecUsd usd, MockCoin coin, MockRouter r, XSpoke spoke) {
        usd = new DecUsd(dec);
        coin = new MockCoin();
        r = new MockRouter(usd, coin);
        spoke = new XSpoke();
        // a user under $0.10 here gets a top-up
        x = new RaceCrossUsdc(spoke, IERC20(address(usd)), r, RaceFactory(address(0)), BASE, IERC20(BASE_USDC), 6, (10 ** dec) / 10);
    }

    function _order(address coin, uint256 minOut, uint256 gasUsd) internal view returns (bytes memory) {
        return abi.encode(uint8(0), abi.encode(RaceCross.Order(user, coin, minOut, gasUsd, block.timestamp + 1 hours)));
    }

    function test_buyDeliversCoinsAndTopsUpGas() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        spoke.fill(usd, address(x), 10e6, _order(address(coin), 1, 0.3e6));
        assertEq(usd.balanceOf(user), 0.3e6, "30 cents of gas");
        assertEq(coin.balanceOf(user), 9.7e6, "the rest bought coins");
        assertEq(usd.balanceOf(address(x)), 0, "nothing kept");
    }

    function test_noTopUpWhenUserHasGas() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        usd.mint(user, 1e6); // $1 of gas already
        spoke.fill(usd, address(x), 10e6, _order(address(coin), 1, 0.3e6));
        assertEq(coin.balanceOf(user), 10e6, "all of it bought coins");
        assertEq(usd.balanceOf(user), 1e6);
    }

    function test_topUpCappedAt50CentsAndAQuarter() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        assertEq(x.gasFor(user, 5e6, 100e6), 0.5e6, "never above 50 cents");
        assertEq(x.gasFor(user, 0.3e6, 0.8e6), 0.2e6, "never above a quarter of the buy");
        assertEq(x.gasFor(user, 0, 100e6), 0, "none asked");
        spoke.fill(usd, address(x), 100e6, _order(address(coin), 1, 5e6));
        assertEq(usd.balanceOf(user), 0.5e6);
        assertEq(coin.balanceOf(user), 99.5e6);
    }

    function test_failedBuyRefundsDollarsHere() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, MockRouter r, XSpoke spoke) = _setup(6);
        r.breakIt(true);
        spoke.fill(usd, address(x), 10e6, _order(address(coin), 1, 0.3e6));
        assertEq(coin.balanceOf(user), 0);
        assertEq(usd.balanceOf(user), 10e6, "gas + refund: all of it back to the user");
        assertEq(usd.balanceOf(address(x)), 0);
    }

    function test_slippageRefunds() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        spoke.fill(usd, address(x), 10e6, _order(address(coin), 100e6, 0));
        assertEq(usd.balanceOf(user), 10e6);
        assertEq(coin.balanceOf(user), 0);
    }

    function test_expiredOrderRefunds() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        bytes memory m = _order(address(coin), 1, 0);
        vm.warp(block.timestamp + 2 hours);
        spoke.fill(usd, address(x), 10e6, m);
        assertEq(usd.balanceOf(user), 10e6);
    }

    function test_noUserRefusedSoAcrossRefundsTheSender() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        bytes memory m = abi.encode(uint8(0), abi.encode(RaceCross.Order(address(0), address(coin), 1, 0, block.timestamp + 1 hours)));
        vm.expectRevert(RaceCross.NoUser.selector);
        spoke.fill(usd, address(x), 10e6, m);
    }

    function test_onlySpokeOnlyDollar() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(6);
        vm.expectRevert(RaceCross.NotSpokePool.selector);
        x.handleV3AcrossMessage(address(usd), 1, address(0), _order(address(coin), 1, 0));
        DecUsd other = new DecUsd(6);
        vm.expectRevert(RaceCross.WrongToken.selector);
        spoke.fill(other, address(x), 1e6, _order(address(coin), 1, 0));
        vm.expectRevert(RaceCross.NotSelf.selector);
        x.dropGas(user, 1);
    }

    function test_sellAndSendHome18to6() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, , XSpoke spoke) = _setup(18);
        coin.mint(user, 50e18);
        vm.startPrank(user);
        coin.approve(address(x), type(uint256).max);
        uint256 got = x.sellAndSendHome(address(coin), 50e18, 1, 0.05e18, block.timestamp);
        vm.stopPrank();
        assertEq(got, 50e18);
        (address depositor, address recipient, address inT, address outT, uint256 inA, uint256 outA, uint256 dst) = spoke.last();
        assertEq(depositor, user, "refunds go to the user");
        assertEq(recipient, user, "home to the user's own address");
        assertEq(inT, address(usd));
        assertEq(outT, BASE_USDC);
        assertEq(inA, 50e18);
        assertEq(outA, 49.95e6, "asked on Base in 6 decimals, after the relay fee");
        assertEq(dst, BASE);
        assertEq(usd.balanceOf(address(x)), 0);
        assertEq(coin.balanceOf(address(x)), 0);
    }

    function test_sendHome() public {
        (RaceCrossUsdc x, DecUsd usd, , , XSpoke spoke) = _setup(6);
        usd.mint(user, 3e6);
        vm.startPrank(user);
        usd.approve(address(x), 3e6);
        x.sendHome(3e6, 0.01e6);
        vm.stopPrank();
        (, , , , uint256 inA, uint256 outA, ) = spoke.last();
        assertEq(inA, 3e6);
        assertEq(outA, 2.99e6);
    }

    function test_feeAboveAmountRefused() public {
        (RaceCrossUsdc x, DecUsd usd, , , ) = _setup(6);
        usd.mint(user, 1e6);
        vm.startPrank(user);
        usd.approve(address(x), 1e6);
        vm.expectRevert(RaceCross.FeeTooHigh.selector);
        x.sendHome(1e6, 1e6);
        vm.stopPrank();
    }

    function test_sellSlippageReverts() public {
        (RaceCrossUsdc x, , MockCoin coin, , ) = _setup(6);
        coin.mint(user, 5e18);
        vm.startPrank(user);
        coin.approve(address(x), type(uint256).max);
        vm.expectRevert();
        x.sellAndSendHome(address(coin), 5e18, 6e18, 0, block.timestamp);
        vm.stopPrank();
    }

    /// A pool that takes only part of the dollars (or coins): the rest goes back to the user.
    function test_partialFillsReturnTheRest() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, MockRouter r, XSpoke spoke) = _setup(6);
        r.setPartial(true);
        spoke.fill(usd, address(x), 10e6, _order(address(coin), 1, 0));
        assertEq(coin.balanceOf(user), 5e6, "half bought");
        assertEq(usd.balanceOf(user), 5e6, "the unused half came back");
        assertEq(usd.balanceOf(address(x)), 0);
        assertEq(usd.allowance(address(x), address(r)), 0, "no approval left behind");
        vm.startPrank(user);
        coin.approve(address(x), type(uint256).max);
        x.sellAndSendHome(address(coin), 4e6, 1, 0, block.timestamp);
        vm.stopPrank();
        assertEq(coin.balanceOf(user), 3e6, "unsold coins came back (5 - 4 + 2)");
        assertEq(coin.balanceOf(address(x)), 0);
        assertEq(coin.allowance(address(x), address(r)), 0);
    }

    /// A relayer can't starve the buy to force a refund: the fill fails instead (no payout).
    function test_starvedFillReverts() public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, MockRouter r, XSpoke spoke) = _setup(6);
        bytes memory m = _order(address(coin), 1, 0);
        // too little gas for the buy at all
        vm.expectRevert(RaceCross.LowGas.selector);
        spoke.fill{gas: 450_000}(usd, address(x), 10e6, m);
        // the buy runs out of gas inside the router
        r.setHungry(true);
        vm.expectRevert(RaceCross.LowGas.selector);
        spoke.fill{gas: 3_000_000}(usd, address(x), 10e6, m);
    }

    /// Whatever arrives, all of it ends with the user (coins + gas, or dollars back).
    function testFuzz_nothingStuck(uint256 amount, uint256 gasUsd, bool broken, uint256 userGas) public {
        (RaceCrossUsdc x, DecUsd usd, MockCoin coin, MockRouter r, XSpoke spoke) = _setup(6);
        amount = bound(amount, 1, 1e15);
        gasUsd = bound(gasUsd, 0, 10e6);
        userGas = bound(userGas, 0, 1e6);
        usd.mint(user, userGas);
        r.breakIt(broken);
        spoke.fill(usd, address(x), amount, _order(address(coin), 0, gasUsd));
        assertEq(usd.balanceOf(address(x)), 0, "contract keeps nothing");
        assertEq(usd.balanceOf(user) - userGas + coin.balanceOf(user), amount, "every dollar reached the user");
    }
}
