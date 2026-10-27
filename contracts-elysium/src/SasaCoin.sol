// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A coin launched on sasa (Elysium). Fixed supply, minted once to the launcher, which puts all of
 * it into a locked pool in the same transaction. No owner, no mint, no tax, no blacklist.
 */
contract SasaCoin is ERC20 {
    /// Where apps read the coin's picture and links (sasa's metadata JSON).
    string public tokenURI;
    /// The account that launched it (gets the creator share of the pool fees).
    address public immutable creator;
    /// The sasa launcher that made it.
    address public immutable launcher;

    constructor(string memory name_, string memory symbol_, string memory uri_, uint256 supply, address creator_)
        ERC20(name_, symbol_)
    {
        tokenURI = uri_;
        creator = creator_;
        launcher = msg.sender;
        _mint(msg.sender, supply);
    }
}
