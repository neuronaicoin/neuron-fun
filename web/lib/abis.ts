import { parseAbi, parseAbiItem } from "viem";

export const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol, uint8 feeMode)"
);

export const factoryAbi = parseAbi([
  "function launch(string name, string symbol, string logo, string description, bytes32 launchKey, uint256 firstBuy, uint256 minTokensOut, uint8 feeMode) returns (address curve, address token, uint256 tokensBought)",
  "function launchesOpen() view returns (bool)",
  "function config() view returns (uint256 virtualNative, uint256 virtualToken, uint256 tokensForSale, uint256 graduationTokens, uint16 feeBps, uint16 creatorShareBps, uint256 minGraduationNative)",
  "error BuysPaused()",
  "error CapReached(uint256 total, uint256 cap)",
  "error LaunchesClosed()",
  "function launchLocked(string name, string symbol, string logo, string description, bytes32 launchKey, uint256 firstBuy, uint256 minTokensOut, uint8 feeMode, uint256 lockSeconds) returns (address curve, address token, uint256 tokensBought)",
  "error CreatorLocked(uint256 until)",
  "error LockTooLong()",
]);

/** Beta safety locks on the v3 factory (see contracts/src/curve/NeuronCurveFactory.sol). */
export const safetyAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function buysPaused() view returns (bool)",
  "function nativeCap() view returns (uint256)",
  "function totalNative() view returns (uint256)",
  "function capRoom() view returns (uint256)",
  "function curveCount() view returns (uint256)",
  "function pauseBuys()",
  "function unpauseBuys()",
  "function setNativeCap(uint256 cap)",
  "function setGuardian(address g)",
  "function acceptOwnership()",
  "event BuysPausedSet(bool paused, address by)",
  "event NativeCapSet(uint256 cap)",
  "event GuardianSet(address guardian)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
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
  "function buy(uint256 amountIn, uint256 minTokensOut, address recipient) returns (uint256)",
  "function sell(uint256 tokenAmount, uint256 minNativeOut, address recipient) returns (uint256)",
  "function claimCreatorFees() returns (uint256)",
  "function migrator() view returns (address)",
  "error BuysPaused()",
  "error CapReached(uint256 total, uint256 cap)",
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
  "function buy(address token, uint256 usdcIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256 tokensOut)",
  "function sell(address token, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline) returns (uint256 nativeOut)",
]);

export const migratorAbi = parseAbi([
  "function collectFees(address token) returns (uint256 nativeFees, uint256 tokenFees)",
  "function buybackFunds(address token) view returns (uint256)",
  "function buyback(address token) returns (uint256 spent, uint256 burned)",
]);

/** Auto orders (contracts/src/curve/SasaOrders.sol). */
export const ordersAbi = parseAbi([
  "function placeSell(address curve, address router, uint256 amount, uint256 minOut, uint256 maxOut, uint64 expiry) returns (uint256)",
  "function placeBuy(address curve, address router, uint256 amount, uint256 minOut, uint256 maxOut, uint64 expiry) returns (uint256)",
  "function cancel(uint256 id)",
  "function ordersOf(address owner) view returns (uint256[])",
  "function orders(uint256 id) view returns (address owner, address curve, address token, address router, bool isBuy, bool open, uint64 expiry, uint256 amount, uint256 minOut, uint256 maxOut)",
  "error NotOwner()",
  "error NotOpen()",
  "error Expired()",
  "error BadOrder()",
]);

/** The USDC every coin trades against (TestUSDC on testnets adds a free faucet). */
export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function faucet(address to)",
  "function lastFaucet(address) view returns (uint256)",
  "error TooSoon(uint256 next)",
]);
