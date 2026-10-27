// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SasaV3Launcher, IV3PositionManager, IWrappedNative} from "../src/SasaV3Launcher.sol";

/**
 * Deploys the sasa launcher on Elysium (or any chain with a Uniswap-v3-style DEX), then launches one
 * smoke-test coin with a tiny first buy and checks it end to end.
 *
 * env: PRIVATE_KEY, NPM (position manager), WHYPE (wrapped native), OWNER, TREASURY, START_MC (wei),
 *      CREATOR_BPS, FEE (default 10000 = 1%), SPACING (default 200), SMOKE_BUY (wei, 0 = skip)
 */
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address npm = vm.envAddress("NPM");
        address whype = vm.envAddress("WHYPE");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        uint256 startMc = vm.envUint("START_MC");
        uint16 creatorBps = uint16(vm.envUint("CREATOR_BPS"));
        uint24 fee = uint24(vm.envOr("FEE", uint256(10_000)));
        int24 spacing = int24(int256(vm.envOr("SPACING", uint256(200))));
        uint256 smokeBuy = vm.envOr("SMOKE_BUY", uint256(0));

        require(npm.code.length > 0, "NPM has no code on this chain");
        require(whype.code.length > 0, "WHYPE has no code on this chain");
        address me = vm.addr(key);
        console2.log("deployer", me, "balance", me.balance);

        vm.startBroadcast(key);
        SasaV3Launcher l = new SasaV3Launcher(
            owner, IV3PositionManager(npm), IWrappedNative(whype), fee, spacing, treasury, startMc, creatorBps
        );
        address coin;
        uint256 bought;
        if (smokeBuy > 0) {
            (coin, bought) = l.launch{value: smokeBuy}("sasa smoke test", "SASATEST", "https://sasapad.fun", me, 0);
        }
        vm.stopBroadcast();

        console2.log("launcher", address(l));
        if (coin != address(0)) {
            (uint256 tokenId, address pool,,,) = l.coins(coin);
            console2.log("smoke coin", coin, "pool", pool);
            console2.log("tokenId", tokenId, "bought", bought);
            require(bought > 0 && IERC20(coin).balanceOf(me) == bought, "smoke buy failed");
            require(IERC20(coin).balanceOf(address(l)) == 0, "coins left in launcher");
        }

        string memory o = "d";
        vm.serializeAddress(o, "launcher", address(l));
        vm.serializeAddress(o, "positionManager", npm);
        vm.serializeAddress(o, "wrapped", whype);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeAddress(o, "treasury", treasury);
        vm.serializeUint(o, "fee", fee);
        vm.serializeUint(o, "startMc", startMc);
        vm.serializeUint(o, "creatorBps", creatorBps);
        vm.serializeUint(o, "block", block.number);
        string memory json = vm.serializeAddress(o, "smokeCoin", coin);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
