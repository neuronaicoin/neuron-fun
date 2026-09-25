import { parseAbi, parseAbiItem } from "viem";

export const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol)"
);

export const factoryAbi = parseAbi([
  "function launch(string name, string symbol, string logo, string description, bytes32 launchKey, uint256 minTokensOut) payable returns (address curve, address token, uint256 tokensBought)",
  "function launchesOpen() view returns (bool)",
]);

export const curveAbi = parseAbi([
  "function state() view returns (uint8)",
  "function realNative() view returns (uint256)",
  "function virtualNative() view returns (uint256)",
  "function virtualToken() view returns (uint256)",
  "function tokensForSale() view returns (uint256)",
  "function minGraduationNative() view returns (uint256)",
  "function creatorFees() view returns (uint256)",
  "function quoteBuy(uint256 nativeIn) view returns (uint256)",
  "function quoteSell(uint256 tokenAmount) view returns (uint256)",
  "function buy(uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokenAmount, uint256 minNativeOut, address recipient) returns (uint256)",
  "function claimCreatorFees() returns (uint256)",
]);

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
]);
