// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
// imported only so they are compiled for the size check
import {RaceBuilder} from "../src/race/RaceBuilder.sol";
import {RaceBuilderEth} from "../src/race/RaceBuilderEth.sol";
import {RaceBuilderPcs} from "../src/race/RaceBuilderPcs.sol";
import {RaceMergerEth} from "../src/race/RaceMergerEth.sol";
import {RaceFactory} from "../src/race/RaceFactory.sol";
import {RaceSeat} from "../src/race/RaceSeat.sol";
import {RaceTradeEth} from "../src/race/RaceTradeEth.sol";
import {RaceTradePcs} from "../src/race/RaceTradePcs.sol";
import {RaceCrossEth, RaceCrossPcs, RaceCrossUsdc} from "../src/race/RaceCross.sol";
import {UsdPoolRouter} from "../src/usd/UsdPoolRouter.sol";
import {OmniHub} from "../src/omni/OmniHub.sol";
import {OmniCoinDeployer} from "../src/omni/OmniDeployers.sol";
import {ConsolidatorV6} from "../src/omni/ConsolidatorV6.sol";
import {AcrossUsdBridge} from "../src/omni/AcrossUsdBridge.sol";
import {LaunchCoin} from "../src/omni/LaunchCoin.sol";
import {SasaFeeVault} from "../src/fees/SasaFeeVault.sol";
import {AutoOrders} from "../src/auto/AutoOrders.sol";

/// @notice Every contract sasa deploys on mainnet must fit the chains' contract size limit
/// (EIP-170: 24,576 bytes of code; 49,152 bytes to create it). The other tests run without
/// that limit, so without this check a contract that's too big only fails at the real deploy.
contract SizesTest is Test {
    uint256 constant MAX_CODE = 24_576;
    uint256 constant MAX_INIT = 49_152;

    function _check(string memory artifact) internal view {
        uint256 code = vm.getDeployedCode(artifact).length;
        uint256 init = vm.getCode(artifact).length;
        assertLe(code, MAX_CODE, string.concat(artifact, ": code over 24,576 bytes"));
        assertLe(init, MAX_INIT, string.concat(artifact, ": creation code over 49,152 bytes"));
    }

    function test_sizesUnderLimit() public view {
        _check("RaceBuilder.sol:RaceBuilder");
        _check("RaceBuilderEth.sol:RaceBuilderEth");
        _check("RaceBuilderPcs.sol:RaceBuilderPcs");
        _check("RaceMergerEth.sol:RaceMergerEth");
        _check("RaceFactory.sol:RaceFactory");
        _check("RaceSeat.sol:RaceSeat");
        _check("RaceTradeEth.sol:RaceTradeEth");
        _check("RaceTradePcs.sol:RaceTradePcs");
        _check("RaceCross.sol:RaceCrossEth");
        _check("RaceCross.sol:RaceCrossPcs");
        _check("RaceCross.sol:RaceCrossUsdc");
        _check("UsdPoolRouter.sol:UsdPoolRouter");
        _check("OmniHub.sol:OmniHub");
        _check("OmniDeployers.sol:OmniCoinDeployer");
        _check("ConsolidatorV6.sol:ConsolidatorV6");
        _check("AcrossUsdBridge.sol:AcrossUsdBridge");
        _check("LaunchCoin.sol:LaunchCoin");
        _check("SasaFeeVault.sol:SasaFeeVault");
        _check("AutoOrders.sol:AutoOrders");
    }
}
