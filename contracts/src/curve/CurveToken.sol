// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title CurveToken
 * @notice A Neuron.fun coin. The whole fixed supply is minted once, to its
 * bonding curve. No owner, no minting, no fees on transfer.
 */
contract CurveToken is ERC20 {
    string public logo;
    string public description;

    constructor(string memory name_, string memory symbol_, string memory logo_, string memory description_, uint256 supply, address to)
        ERC20(name_, symbol_)
    {
        logo = logo_;
        description = description_;
        _mint(to, supply);
    }
}
