// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TestPoolRebalancer, ITestFeedPrice} from "../../src/race/testnet/TestnetSupport.sol";

/**
 * TESTNET ONLY. Pushes the test ETH / dollar v4 pool of one chain back to the feed price.
 * Reads deployments/race/<chainId>.json (eth kind, testnet: true). Deploys a fresh
 * TestPoolRebalancer unless REBALANCER is set. The deployer pays the side the pool needs
 * (ETH up to ETH_BUDGET_WEI, default 0.01, leftovers refunded; dollars via approve) and
 * gets the other side back. Refuses to run on a mainnet.
 */
contract RebalanceTestPool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        string memory path = string.concat(vm.envOr("DEPLOY_DIR", string("./deployments/race/")), vm.toString(block.chainid), ".json");
        string memory j = vm.readFile(path);
        require(vm.parseJsonBool(j, ".testnet"), "not a testnet deployment");
        require(keccak256(bytes(vm.parseJsonString(j, ".builderKind"))) == keccak256("eth"), "only the eth kind has a v4 dollar pool");
        address usd = vm.parseJsonAddress(j, ".usd");
        address feed = vm.parseJsonAddress(j, ".feed");
        IPoolManager pm = IPoolManager(vm.parseJsonAddress(j, ".poolManager"));
        PoolKey memory k = PoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(usd),
            uint24(vm.parseJsonUint(j, ".dollarFee")),
            int24(int256(vm.parseJsonUint(j, ".dollarSpacing"))),
            IHooks(address(0))
        );
        (, int256 a,,,) = ITestFeedPrice(feed).latestRoundData();
        require(a > 0, "feed");
        uint256 usdPerEth = (uint256(a) * 10 ** IERC20Metadata(usd).decimals()) / 10 ** ITestFeedPrice(feed).decimals();
        uint160 target = uint160(Math.sqrt(Math.mulDiv(usdPerEth, 1 << 192, 1 ether)));
        (uint160 before,,,) = pm.getSlot0(k.toId());
        require(before != 0, "dollar pool does not exist");
        console2.log("pool sqrt price:", before);
        console2.log("feed sqrt price:", target);
        uint256 diffBps = before > target ? ((before - target) * 10_000) / target : ((target - before) * 10_000) / target;
        console2.log("off by (bps of sqrt price, ~half the price gap):", diffBps);
        if (diffBps < vm.envOr("MIN_OFF_BPS", uint256(10))) {
            console2.log("close enough, nothing to do");
            return;
        }
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        uint256 budget = vm.envOr("ETH_BUDGET_WEI", uint256(0.03 ether));
        // never spend the gas money: keep RESERVE_WEI (default 0.003) for the race itself
        uint256 reserve = vm.envOr("RESERVE_WEI", uint256(0.003 ether));
        budget = me.balance > reserve + budget ? budget : (me.balance > reserve ? me.balance - reserve : 0);
        vm.startBroadcast(key);
        address rb = vm.envOr("REBALANCER", address(0));
        if (rb == address(0)) rb = address(new TestPoolRebalancer(pm));
        IERC20(usd).approve(rb, type(uint256).max);
        TestPoolRebalancer(payable(rb)).rebalance{value: before > target ? budget : 0}(k, target);
        vm.stopBroadcast();
        (uint160 after_,,,) = pm.getSlot0(k.toId());
        console2.log("pool sqrt price now:", after_);
        if (after_ != target) {
            uint256 left = after_ > target ? ((after_ - target) * 10_000) / target : ((target - after_) * 10_000) / target;
            console2.log("WARNING: the ETH budget ran out before the feed price; still off by (bps):", left);
            console2.log("  send more test ETH to the deployer or raise ETH_BUDGET_WEI");
        }
        console2.log("rebalancer:", rb);
        console2.log("deployer ETH:", me.balance);
    }
}
