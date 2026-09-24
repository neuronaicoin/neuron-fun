import { parseAbi, parseAbiItem } from "viem";

export const launchEvent = parseAbiItem(
  "event NeuronLaunch(address indexed token, address indexed parent, address indexed creator, address splitter, uint16 parentShareBps, uint256 devBuyEth, uint256 devBuyTokens)"
);

export const launcherAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "parent", type: "address" },
      { name: "minTokensOut", type: "uint256" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "splitter", type: "address" },
      { name: "devBuyTokens", type: "uint256" },
    ],
  },
  ...parseAbi(["function launchCount() view returns (uint256)"]),
] as const;

export const factoryAbi = [
  ...parseAbi(["function launchFee() view returns (uint256)"]),
  {
    type: "function",
    name: "poolKeyFor",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
  },
] as const;

export const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "payable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

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

export const splitterAbi = parseAbi([
  "function totalParentBurned() view returns (uint256)",
  "function totalParentEthSpent() view returns (uint256)",
  "function totalCreatorEthPaid() view returns (uint256)",
]);

export const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

export const registryEvent = parseAbiItem("event ParentSet(address indexed parent, bytes32 routeId)");
export const registryAbi = parseAbi(["function isListed(address parent) view returns (bool)"]);
