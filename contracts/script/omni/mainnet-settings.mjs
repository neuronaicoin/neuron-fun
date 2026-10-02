// Prints every setting the off-chain side needs after the mainnet deploy, read from
// contracts/deployments/mainnet: the site's lib/mainnet.json, and the CHAINS values for the
// Railway services (indexer, rewards) plus the keeper's variables.
//   node script/omni/mainnet-settings.mjs
import { readFileSync, existsSync } from "node:fs";

const DIR = new URL("../../deployments/mainnet/", import.meta.url);
const CHAINS = [
  { key: "robinhood", name: "robinhood", chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com" },
  { key: "base", name: "base", chainId: 8453, rpc: "https://mainnet.base.org" },
];
const read = (f) => (existsSync(new URL(f, DIR)) ? JSON.parse(readFileSync(new URL(f, DIR), "utf8")) : null);

const site = {};
const indexer = [];
const rewards = [];
for (const c of CHAINS) {
  const d = read(`${c.chainId}.json`);
  const r = read(`${c.chainId}-rewards.json`);
  const o = read(`${c.chainId}-orders.json`);
  if (!d) throw new Error(`no deployment for ${c.key} (${c.chainId})`);
  site[c.key] = { router: d.router, migrator: d.migrator, orders: o?.orders, boost: r?.boost, startBlock: String(d.startBlock), gasPolicy: "PUT-ALCHEMY-MAINNET-POLICY-ID" };
  indexer.push({ name: c.name, chainId: c.chainId, rpc: c.rpc, factory: [], omniFactory: d.factory, startBlock: d.startBlock, router: [d.router], ...(o ? { orders: o.orders } : {}), ...(r?.boost ? { boost: r.boost } : {}), quote: "USDC" });
  if (r) rewards.push({ name: c.name, chainId: c.chainId, rpc: c.rpc, splitter: r.splitter, disperse: r.disperse, ...(o ? { orders: o.orders } : {}), token: d.usd });
}
console.log("=== web/lib/mainnet.json ===");
console.log(JSON.stringify(site, null, 2));
console.log("\n=== Railway indexer (neuron-fun) CHAINS ===");
console.log(JSON.stringify(indexer));
console.log("\n=== Railway rewards CHAINS ===");
console.log(JSON.stringify(rewards));
console.log("\n=== Railway keeper ===");
console.log("DEPLOYMENTS=../contracts/deployments/mainnet");
for (const c of CHAINS) console.log(`RPC_${c.chainId}=${c.rpc}`);
console.log("PRIVATE_KEY=<the mainnet keeper wallet's key (a new wallet with a little ETH on both chains)>");
