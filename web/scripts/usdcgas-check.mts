/**
 * Runs the site's own lib/usdcgas.ts (what email accounts use on Base) on Base Sepolia with
 * the throwaway proof-test account from scripts/paymaster-poc.mts: a 0.10 USDC transfer to
 * itself, network fee paid in USDC, no ETH.   npx tsx scripts/usdcgas-check.mts
 */
import { createPublicClient, erc20Abi, formatUnits, http, keccak256, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { gasUsdcOf, sendWithUsdcGas } from "../lib/usdcgas";
import { call } from "../lib/tx";

const owner = privateKeyToAccount(keccak256(toHex("sasa paymaster proof test, Base Sepolia only")));
const usdc = gasUsdcOf(baseSepolia.id)!;
const client = createPublicClient({ chain: baseSepolia, transport: http() });
const bal = () => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] });

const before = await bal();
console.log(`account ${owner.address}: USDC ${formatUnits(before, 6)}, ETH ${formatUnits(await client.getBalance({ address: owner.address }), 18)}`);
const tx = await sendWithUsdcGas(
  baseSepolia,
  owner,
  (a) => owner.signAuthorization(a),
  [call(usdc, erc20Abi as never, "transfer", [owner.address, 100_000n])],
  (m) => console.log(`   ${m}`)
);
// read at the block the transaction landed in (a load-balanced public node can lag a block)
const { blockNumber: at } = await client.waitForTransactionReceipt({ hash: tx });
const balAt = (blockNumber: bigint) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner.address], blockNumber });
const after = await balAt(at);
const beforeAt = await balAt(at - 1n);
const eth = await client.getBalance({ address: owner.address, blockNumber: at });
void before;
console.log(`tx ${tx}\nnetwork fee in USDC: ${formatUnits(beforeAt - after, 6)} · ETH ${formatUnits(eth, 18)}`);
if (!(beforeAt - after > 0n && beforeAt - after < 2_000_000n) || eth !== 0n) {
  console.error("❌ unexpected result");
  process.exit(1);
}
console.log("✅ the site's USDC-gas code works on Base Sepolia");
process.exit(0);
