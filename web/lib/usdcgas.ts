import {
  concat,
  createPublicClient,
  encodePacked,
  erc20Abi,
  hexToBigInt,
  http,
  maxUint256,
  parseAbi,
  parseErc6492Signature,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type SignedAuthorization,
} from "viem";
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction";
import type { Call } from "./tx";
import { ALCHEMY_KEY, PIMLICO_KEY } from "./config";

/**
 * Network fees paid in USDC (Circle Paymaster v0.8 + EIP-7702) for email / Google accounts.
 * The account stays the user's own address; it never needs ETH. Circle takes the fee in USDC
 * (plus its small exchange spread). sasa pays nothing. Proven on Base Sepolia by
 * scripts/paymaster-poc.mts before the site used it.
 *
 * Only on chains where Circle runs the paymaster: Base (and Base Sepolia on testnet).
 */
/** A bundler: Alchemy (its own fee hint) or Pimlico (its gas-price method). Tried in order. */
type Bundler = { kind: "alchemy" | "pimlico"; url: string };
type CircleSetup = { usdc: Address; paymaster: Address; bundlers: Bundler[] };
const CIRCLE: Record<number, CircleSetup> = {
  // Base Sepolia: Circle's test USDC and testnet paymaster; Pimlico's public bundler
  84532: { usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", paymaster: "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966", bundlers: [{ kind: "pimlico", url: "https://public.pimlico.io/v2/84532/rpc" }] },
  // Base: native USDC and Circle's mainnet paymaster. With a Pimlico key (lib/config.ts) the keyed
  // bundler is used; the public one is rate-limited and meant for testing.
  8453: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    paymaster: "0x0578cFB241215b77442a541325d6A4E6dFE700Ec",
    // Alchemy's bundler first (sasa's key, free plan); Pimlico's public one if Alchemy can't take it
    bundlers: [
      ...(ALCHEMY_KEY ? [{ kind: "alchemy" as const, url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` }] : []),
      PIMLICO_KEY
        ? { kind: "pimlico" as const, url: `https://api.pimlico.io/v2/8453/rpc?apikey=${PIMLICO_KEY}` }
        : { kind: "pimlico" as const, url: "https://public.pimlico.io/v2/8453/rpc" },
    ],
  },
};

export const usdcGasChain = (chainId: number) => CIRCLE[chainId] ?? null;
export const gasUsdcOf = (chainId: number) => CIRCLE[chainId]?.usdc ?? null;

/** What one transaction's network fee may take at most (2 USDC); the real fee is about a cent. */
const PERMIT_AMOUNT = 2_000_000n;
/** Below this the account can't pay a network fee. */
export const MIN_GAS_USDC = 20_000n; // $0.02

const usdcExtra = parseAbi(["function nonces(address) view returns (uint256)", "function name() view returns (string)", "function version() view returns (string)"]);

/** Signs an EIP-7702 authorization (Privy's embedded wallet does it without a popup). */
export type SignAuthorization = (a: { contractAddress: Address; chainId: number; nonce: number }) => Promise<SignedAuthorization>;

const clients = new Map<number, PublicClient>();
function pub(chain: Chain): PublicClient {
  let c = clients.get(chain.id);
  if (!c) {
    c = createPublicClient({ chain, transport: http() }) as PublicClient;
    clients.set(chain.id, c);
  }
  return c;
}

export class GasUsdcMissing extends Error {
  constructor() {
    super("GAS_USDC_MISSING");
  }
}

/**
 * Sends `calls` from the user's own address with the network fee paid in USDC.
 * Returns the transaction hash once mined.
 */
export async function sendWithUsdcGas(
  chain: Chain,
  owner: LocalAccount,
  signAuthorization: SignAuthorization,
  calls: Call[],
  onStep?: (msg: string) => void
): Promise<Hex> {
  const setup = CIRCLE[chain.id];
  if (!setup) throw new Error("Network fees in USDC aren't available on this chain.");
  const client = pub(chain);
  // the account only asks its owner for signMessage / signTypedData (Privy's embedded wallet has both)
  const account = await toSimple7702SmartAccount({ client, owner: owner as never });

  const gasBal = await client.readContract({ address: setup.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (gasBal < MIN_GAS_USDC) throw new GasUsdcMissing();

  // the permit lets Circle's paymaster take this operation's fee (at most PERMIT_AMOUNT) in USDC
  const [name, version, nonce] = await Promise.all([
    client.readContract({ address: setup.usdc, abi: usdcExtra, functionName: "name" }),
    client.readContract({ address: setup.usdc, abi: usdcExtra, functionName: "version" }),
    client.readContract({ address: setup.usdc, abi: usdcExtra, functionName: "nonces", args: [account.address] }),
  ]);
  const typed = {
    domain: { name, version, chainId: chain.id, verifyingContract: setup.usdc },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    // the paymaster can't read the block time, so the permit has no deadline; it only covers gas
    message: { owner: account.address, spender: setup.paymaster, value: PERMIT_AMOUNT, nonce, deadline: maxUint256 },
  };
  const paymaster = {
    async getPaymasterData() {
      const { signature } = parseErc6492Signature(await account.signTypedData(typed));
      return {
        paymaster: setup.paymaster,
        paymasterData: encodePacked(["uint8", "address", "uint256", "bytes"], [0, setup.usdc, PERMIT_AMOUNT, signature]),
        paymasterVerificationGasLimit: 200_000n,
        paymasterPostOpGasLimit: 35_000n,
        isFinal: true,
      };
    },
  };

  const makeBundler = (b: Bundler) =>
    createBundlerClient({
      account,
      client,
      paymaster,
      transport: http(b.url),
      userOperation: {
        estimateFeesPerGas: async ({ bundlerClient }) => {
          if (b.kind === "pimlico") {
            const { standard } = (await bundlerClient.request({ method: "pimlico_getUserOperationGasPrice" as never })) as {
              standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
            };
            return { maxFeePerGas: hexToBigInt(standard.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(standard.maxPriorityFeePerGas) };
          }
          // Alchemy: at least its own priority-fee hint (+25%), and room for the base fee to double
          const [hint, block] = await Promise.all([
            bundlerClient.request({ method: "rundler_maxPriorityFeePerGas" as never }) as Promise<Hex>,
            client.getBlock({ blockTag: "latest" }),
          ]);
          const tip = (hexToBigInt(hint) * 125n) / 100n + 1n;
          return { maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip, maxPriorityFeePerGas: tip };
        },
      },
    });

  // The address must point at the smart-account code (EIP-7702). Only signed when it doesn't yet.
  const impl = account.authorization.address;
  const code = await client.getCode({ address: account.address });
  const delegated = !!code && code.toLowerCase() === concat(["0xef0100", impl]).toLowerCase();
  const authorization = delegated
    ? undefined
    : await signAuthorization({ contractAddress: impl, chainId: chain.id, nonce: await client.getTransactionCount({ address: account.address }) });

  onStep?.("Sending…");
  // Try each bundler in turn. Every try uses the account's same nonce, so even if a bundler took an
  // operation and only its answer was lost, the next try can't run the calls a second time.
  let bundler: ReturnType<typeof makeBundler> | null = null;
  let hash: Hex | null = null;
  let lastErr: unknown = null;
  for (const b of setup.bundlers) {
    const bc = makeBundler(b);
    try {
      hash = await bc.sendUserOperation({
        account,
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        ...(authorization ? { authorization } : {}),
      });
      bundler = bc;
      break;
    } catch (e) {
      const text = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "") + " " + String((e as { details?: string })?.details ?? "");
      // An earlier bundler did take it (only its answer got lost): this one now finds the account
      // already set up or the nonce used. The operation is on its way, it didn't fail.
      if (lastErr !== null && /already been deployed|AA10|AA25|invalid (account )?nonce|nonce too low/i.test(text)) throw new Error("SENT_UNCONFIRMED");
      lastErr = e;
      // the calls themselves fail: another bundler won't change that
      if (/revert/i.test(text)) throw e;
    }
  }
  if (!bundler || !hash) throw lastErr ?? new Error("Couldn't send. Try again in a moment.");
  onStep?.("Almost done…");
  let receipt: Awaited<ReturnType<typeof bundler.waitForUserOperationReceipt>>;
  try {
    receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 1_500 });
  } catch {
    // sent, but the bundler never confirmed it back: say so instead of "failed"
    throw new Error("SENT_UNCONFIRMED");
  }
  if (!receipt.success) throw new Error("The network rejected the transaction.");
  return receipt.receipt.transactionHash;
}
