/**
 * Proof test for sasa's "gas in USDC" (Circle Paymaster v0.8, EIP-7702) on Base Sepolia,
 * before the site uses it. A throwaway test account (its key is below on purpose: it only
 * ever holds free faucet test USDC) sends 0.10 USDC to itself and pays the network fee in
 * USDC; it never holds ETH.
 *
 *   npx tsx scripts/paymaster-poc.mts address   prints the account to fund at faucet.circle.com
 *   npx tsx scripts/paymaster-poc.mts send      the real test
 *
 * Env: BUNDLER_URL (default: Pimlico's public Base Sepolia bundler), RPC_URL.
 */
import {
  createPublicClient,
  encodePacked,
  erc20Abi,
  formatUnits,
  hexToBigInt,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseErc6492Signature,
  toHex,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle USDC on Base Sepolia
const PAYMASTER: Address = "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966"; // Circle Paymaster v0.8, Base Sepolia
const RPC = process.env.RPC_URL || "https://sepolia.base.org";
const BUNDLER = process.env.BUNDLER_URL || `https://public.pimlico.io/v2/${baseSepolia.id}/rpc`;

// Throwaway testnet key (public on purpose; never fund it with anything but faucet test USDC).
const owner = privateKeyToAccount(keccak256(toHex("sasa paymaster proof test, Base Sepolia only")));
const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const usdcExtra = parseAbi(["function nonces(address) view returns (uint256)", "function name() view returns (string)", "function version() view returns (string)"]);

async function main() {
  const mode = process.argv[2] ?? "address";
  const account = await toSimple7702SmartAccount({ client, owner });
  console.log(`account ${account.address} (same as the owner key's address: ${account.address === owner.address})`);
  const bal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const eth = await client.getBalance({ address: account.address });
  console.log(`USDC ${formatUnits(bal, 6)} · ETH ${formatUnits(eth, 18)}`);
  if (mode === "address") return;
  if (bal < 1_000_000n) throw new Error(`fund ${account.address} with Base Sepolia USDC at https://faucet.circle.com first`);

  // EIP-2612 permit: lets the paymaster take up to 2 USDC for this operation's gas
  const permitAmount = 2_000_000n;
  const [name, version, nonce] = await Promise.all([
    client.readContract({ address: USDC, abi: usdcExtra, functionName: "name" }),
    client.readContract({ address: USDC, abi: usdcExtra, functionName: "version" }),
    client.readContract({ address: USDC, abi: usdcExtra, functionName: "nonces", args: [account.address] }),
  ]);
  const typed = {
    domain: { name, version, chainId: baseSepolia.id, verifyingContract: USDC },
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
    // the paymaster can't read the block time, so the permit never expires (it only covers gas)
    message: { owner: account.address, spender: PAYMASTER, value: permitAmount, nonce, deadline: maxUint256 },
  };

  const paymaster = {
    async getPaymasterData() {
      const wrapped = await account.signTypedData(typed);
      const ok = await client.verifyTypedData({ ...typed, address: account.address, signature: wrapped });
      if (!ok) throw new Error("permit signature does not verify");
      const { signature } = parseErc6492Signature(wrapped);
      return {
        paymaster: PAYMASTER,
        paymasterData: encodePacked(["uint8", "address", "uint256", "bytes"], [0, USDC, permitAmount, signature]),
        paymasterVerificationGasLimit: 200_000n,
        paymasterPostOpGasLimit: 35_000n,
        isFinal: true,
      };
    },
  };

  const bundler = createBundlerClient({
    account,
    client,
    paymaster,
    transport: http(BUNDLER),
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const { standard } = (await bundlerClient.request({ method: "pimlico_getUserOperationGasPrice" as never })) as {
          standard: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
        };
        return { maxFeePerGas: hexToBigInt(standard.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(standard.maxPriorityFeePerGas) };
      },
    },
  });

  // EIP-7702: the owner key points its account at the smart-account code (once; harmless to repeat)
  const authorization = await owner.signAuthorization({
    chainId: baseSepolia.id,
    nonce: await client.getTransactionCount({ address: owner.address }),
    contractAddress: account.authorization.address,
  });

  const amount = 100_000n; // 0.10 USDC, to itself
  const before = bal; // re-read at the block before the operation, below
  const hash = await bundler.sendUserOperation({
    account,
    calls: [{ to: USDC, abi: erc20Abi, functionName: "transfer", args: [account.address, amount] }],
    authorization,
  });
  console.log(`user operation ${hash}`);
  const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  console.log(`mined in tx ${receipt.receipt.transactionHash} (success: ${receipt.success})`);
  // read at the block the operation landed in: a load-balanced public node can still be a block behind
  const at = receipt.receipt.blockNumber;
  const after = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address], blockNumber: at });
  const ethAfter = await client.getBalance({ address: account.address });
  const beforeAt = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address], blockNumber: at - 1n });
  const fee = beforeAt - after;
  void before;
  console.log(`network fee paid in USDC: ${formatUnits(fee, 6)} · ETH still ${formatUnits(ethAfter, 18)}`);
  if (!receipt.success) throw new Error("user operation failed");
  if (ethAfter !== 0n && eth === 0n) throw new Error("account unexpectedly holds ETH");
  if (fee <= 0n || fee > permitAmount) throw new Error(`unexpected USDC fee ${fee}`);
  console.log("✅ gas paid in USDC through Circle Paymaster; the account holds no ETH");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
