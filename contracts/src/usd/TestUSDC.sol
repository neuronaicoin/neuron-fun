// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestUSDC
 * @notice Free play money for sasa's testnets: a USDC stand-in (6 decimals)
 * with a faucet anyone can use once a day. Never deployed on mainnet, where
 * sasa uses real USDC.
 */
contract TestUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 100e6; // $100
    uint256 public constant FAUCET_EVERY = 1 days;
    mapping(address => uint256) public lastFaucet;

    event Fauceted(address indexed to, uint256 amount);

    error TooSoon(uint256 next);

    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice $100 of test USDC to `to`, once every 24 hours per wallet.
    /// Anyone may call it for anyone, so the site can top up a new wallet
    /// without that wallet needing gas first.
    function faucet(address to) external {
        uint256 next = lastFaucet[to] + FAUCET_EVERY;
        if (lastFaucet[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastFaucet[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit Fauceted(to, FAUCET_AMOUNT);
    }
}
