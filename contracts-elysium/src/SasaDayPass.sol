// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * sasa Day-1 Pass: a free NFT, one per wallet, minted by the wallet itself (no price, only the
 * network fee). Holders get 2x sasa points on Elysium (counted off-chain by sasa's indexer).
 * The owner can only end the mint early and change where the picture/metadata is read from;
 * nobody can mint for others, take a pass back or charge for it.
 */
contract SasaDayPass is ERC721, Ownable {
    /// Minting closes at this time (unix seconds); 0 = open until the owner ends it.
    uint64 public mintEnd;
    /// Passes minted so far (token ids start at 1).
    uint256 public totalSupply;
    /// Wallets that already minted (one each, even if they move the pass on).
    mapping(address => bool) public minted;

    string private metaUri;

    event MintEnd(uint64 at);

    constructor(address owner_, string memory uri_, uint64 mintEnd_) ERC721("sasa Day-1 Pass", "SASAPASS") Ownable(owner_) {
        metaUri = uri_;
        mintEnd = mintEnd_;
    }

    function mintOpen() public view returns (bool) {
        return mintEnd == 0 || block.timestamp < mintEnd;
    }

    /// Mints the caller's pass. Free; one per wallet.
    function mint() external returns (uint256 id) {
        require(mintOpen(), "mint closed");
        require(!minted[msg.sender], "already minted");
        minted[msg.sender] = true;
        id = ++totalSupply;
        // plain mint: email accounts are smart wallets that may not answer the ERC721 receiver call
        _mint(msg.sender, id);
    }

    /// Every pass shares one picture and description.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return metaUri;
    }

    /// Ends the mint (or moves its end earlier). It can never be reopened.
    function endMint(uint64 at) external onlyOwner {
        uint64 t = at < uint64(block.timestamp) ? uint64(block.timestamp) : at;
        require(mintEnd == 0 || t < mintEnd, "can only end earlier");
        mintEnd = t;
        emit MintEnd(t);
    }

    function setUri(string calldata uri_) external onlyOwner {
        metaUri = uri_;
    }
}
