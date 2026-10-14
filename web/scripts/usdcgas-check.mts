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
const after = await bal();
const eth = await client.getBalance({ address: owner.address });
console.log(`tx ${tx}\nnetwork fee in USDC: ${formatUnits(before - after, 6)} · ETH ${formatUnits(eth, 18)}`);
if (!(before - after > 0n && before - after < 2_000_000n) || eth !== 0n) {
  console.error("❌ unexpected result");
  process.exit(1);
}
console.log("✅ the site's USDC-gas code works on Base Sepolia");
process.exit(0);
