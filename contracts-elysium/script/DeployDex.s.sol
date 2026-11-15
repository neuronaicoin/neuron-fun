// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WHYPE} from "../src/WHYPE.sol";

/**
 * sasa's own Uniswap v3 on a chain that has none it can share (Elysium mainnet): WHYPE, then the
 * official Uniswap v3 factory, position manager and swap router (npm artifacts in v3/). Writes
 * deployments/dex-<chain id>.json; the workflow passes the addresses on to Deploy.s.sol.
 *
 * env: PRIVATE_KEY
 */
contract DeployDex is Script {
    function _create(bytes memory code) internal returns (address a) {
        assembly ("memory-safe") {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0) && a.code.length > 0, "create failed");
    }

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        console2.log("deployer", me, "balance", me.balance);

        vm.startBroadcast(key);
        address whype = address(new WHYPE());
        address factory = _create(vm.getCode("v3/UniswapV3Factory.json"));
        address npm = _create(abi.encodePacked(vm.getCode("v3/NonfungiblePositionManager.json"), abi.encode(factory, whype, address(0))));
        address router = _create(abi.encodePacked(vm.getCode("v3/SwapRouter.json"), abi.encode(factory, whype)));
        vm.stopBroadcast();

        // the 1% pool fee the launcher uses must exist (it does in v3: 10000 / spacing 200)
        (bool ok, bytes memory r) = factory.staticcall(abi.encodeWithSignature("feeAmountTickSpacing(uint24)", uint24(10_000)));
        require(ok && abi.decode(r, (int24)) == 200, "1% fee tier missing");

        console2.log("whype", whype);
        console2.log("factory", factory);
        console2.log("positionManager", npm);
        console2.log("router", router);

        string memory o = "dex";
        vm.serializeAddress(o, "whype", whype);
        vm.serializeAddress(o, "factory", factory);
        vm.serializeAddress(o, "positionManager", npm);
        vm.serializeUint(o, "block", block.number);
        string memory json = vm.serializeAddress(o, "router", router);
        vm.writeJson(json, string.concat("deployments/dex-", vm.toString(block.chainid), ".json"));
    }
}
