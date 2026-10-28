// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SasaDayPass} from "../src/SasaDayPass.sol";

/**
 * Deploys the sasa Day-1 Pass and mints the deployer's own pass as a smoke test.
 * env: PRIVATE_KEY, OWNER, PASS_URI, MINT_END (unix seconds, 0 = until the owner ends it)
 */
contract DeployPass is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        string memory uri = vm.envString("PASS_URI");
        uint64 mintEnd = uint64(vm.envOr("MINT_END", uint256(0)));
        address me = vm.addr(key);
        vm.startBroadcast(key);
        SasaDayPass p = new SasaDayPass(owner, uri, mintEnd);
        uint256 id = p.mint();
        vm.stopBroadcast();
        require(p.ownerOf(id) == me, "smoke mint failed");
        console2.log("pass", address(p), "first id", id);
        string memory o = "p";
        vm.serializeAddress(o, "pass", address(p));
        vm.serializeUint(o, "mintEnd", mintEnd);
        string memory json = vm.serializeUint(o, "block", block.number);
        vm.writeJson(json, string.concat("deployments/pass-", vm.toString(block.chainid), ".json"));
    }
}
