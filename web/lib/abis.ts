import { parseAbi, parseAbiItem } from "viem";

export const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol, uint8 feeMode)"
);

export const factoryAbi = parseAbi([
  "function launch(string name, string symbol, string logo, string description, bytes32 launchKey, uint256 minTokensOut, uint8 feeMode) payable returns (address curve, address token, uint256 tokensBought)",
  "function launchesOpen() view returns (bool)",
  "function config() view returns (uint256 virtualNative, uint256 virtualToken, uint256 tokensForSale, uint256 graduationTokens, uint16 feeBps, uint16 creatorShareBps, uint256 minGraduationNative)",
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
  "function claimable(address holder) view returns (uint256)",
  "function claim(address to) returns (uint256)",
  "function totalDistributed() view returns (uint256)",
  "function pendingRewards() view returns (uint256)",
]);

export const routerAbi = parseAbi([
  "function buy(address token, uint256 minTokensOut, address recipient, uint256 deadline) payable returns (uint256 tokensOut)",
  "function sell(address token, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline) returns (uint256 nativeOut)",
]);

export const migratorAbi = parseAbi([
  "function collectFees(address token) returns (uint256 nativeFees, uint256 tokenFees)",
  "function buybackFunds(address token) view returns (uint256)",
  "function buyback(address token) returns (uint256 spent, uint256 burned)",
]);
