// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAcrossSpokePool} from "../src/omni/AcrossUsdBridge.sol";

interface ICrossMinter {
    function mint(address to, uint256 a) external;
}

interface ICrossReceiver {
    function handleV3AcrossMessage(address token, uint256 amount, address relayer, bytes memory message) external;
}

/// Stands in for Across's SpokePool in the race flows: `fill` plays the relayer delivering
/// dollars (minted / dealt by the test's minter) with a message; deposits are recorded.
contract CrossSpoke is IAcrossSpokePool {
    address public lastDepositor;
    address public lastRecipient;
    address public lastOutputToken;
    uint256 public lastInput;
    uint256 public lastOutput;
    uint256 public lastDst;

    function depositV3Now(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 dst, address, uint32, uint32, bytes calldata)
        external
        payable
    {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        (lastDepositor, lastRecipient, lastOutputToken, lastInput, lastOutput, lastDst) = (depositor, recipient, outputToken, inputAmount, outputAmount, dst);
    }

    function fill(address token, ICrossMinter minter, address to, uint256 amount, bytes calldata message) external {
        minter.mint(to, amount);
        ICrossReceiver(to).handleV3AcrossMessage(token, amount, address(0xF111), message);
    }
}
