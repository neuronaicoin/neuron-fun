// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OFT} from "@layerzerolabs/oft-evm/contracts/OFT.sol";

/**
 * @title TestUsdOft (testnet only)
 * @notice v6 testnet play money: like TestUSDC ($100 a day from the faucet, 6
 * decimals), and also a LayerZero OFT, so v6 can move it between testnets exactly
 * the way mainnet moves real dollars. Never deployed on mainnet.
 */
contract TestUsdOft is OFT {
    uint256 public constant FAUCET_AMOUNT = 100e6;
    uint256 public constant FAUCET_EVERY = 1 days;
    mapping(address => uint256) public lastFaucet;

    event Fauceted(address indexed to, uint256 amount);

    error TooSoon(uint256 next);

    constructor(address endpoint_, address owner_) OFT("Test USDC", "USDC", endpoint_, owner_) Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        uint256 next = lastFaucet[to] + FAUCET_EVERY;
        if (lastFaucet[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastFaucet[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit Fauceted(to, FAUCET_AMOUNT);
    }
}
