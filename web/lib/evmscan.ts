"use client";

/**
 * "Is it safe?": a coin's safety check on the EVM chains sasa trades (app/scan).
 *   Ethereum, BNB Chain, Base  GoPlus's security data through the edge (edge/bot-api.js
 *                              /api/bot/evmscan): sale simulation, taxes, owner powers, holders, LP
 *   Elysium, Robinhood, Arc    read straight from the chain here: owner, mint function, holders
 *                              from the coin's own transfers, creator, age; sasa launches are
 *                              known to be fixed supply with liquidity locked forever
 * Every check is a plain sentence with a pass / fail; the verdict is "clean", "careful" or "trap".
 */
import { getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { ELYSIUM, elysiumClient, launcherAbi } from "./elysium";
import { xChain, xClient } from "./extcross";

export type ScanChain = { id: string; label: string; chainId: number; color: string; goplus: boolean };

export const SCAN_CHAINS: ScanChain[] = [
  { id: "elysium", label: ELYSIUM.testnet ? "Elysium testnet" : "Elysium", chainId: ELYSIUM.chain.id, color: "#3a9bb5", goplus: false },
  { id: "base", label: "Base", chainId: 8453, color: "#0052ff", goplus: true },
  { id: "bsc", label: "BNB Chain", chainId: 56, color: "#f0b90b", goplus: true },
  { id: "robinhood", label: "Robinhood", chainId: 4663, color: "#00c805", goplus: false },
  { id: "eth", label: "Ethereum", chainId: 1, color: "#627eea", goplus: true },
];

export type ScanCheck = { label: string; pass: boolean };
export type ScanResult = {
  name: string | null;
  symbol: string | null;
  checks: ScanCheck[];
  info: string[];
  safety: number;
  verdict: "clean" | "careful" | "trap";
  why: string | null;
  sasa: boolean;
};

const pct = (f: number) => `${(f * 100).toFixed(f * 100 < 1 && f > 0 ? 1 : 0)}%`;

type GoPlus = {
  name: string | null;
  symbol: string | null;
  honeypot: boolean | null;
  cannotSellAll: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  taxChangeable: boolean | null;
  mintable: boolean | null;
  ownerRenounced: boolean | null;
  hiddenOwner: boolean | null;
  takeBackOwnership: boolean | null;
  pausable: boolean | null;
  blacklist: boolean | null;
  openSource: boolean | null;
  holderCount: number | null;
  top10: number | null;
  creatorPct: number | null;
  lpLocked: number | null;
};

function finish(name: string | null, symbol: string | null, items: [string, boolean | null][], traps: string[], info: string[], sasa = false): ScanResult {
  const checks = items.filter((x): x is [string, boolean] => x[1] !== null).map(([label, pass]) => ({ label, pass }));
  const ok = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass);
  return {
    name,
    symbol,
    checks,
    info,
    safety: checks.length ? Math.round((ok / checks.length) * 100) : 0,
    verdict: traps.length ? "trap" : failed.length ? "careful" : "clean",
    why: traps[0] ?? (failed[0] ? `Watch out: ${failed[0].label.toLowerCase()} isn't true here` : null),
    sasa,
  };
}

async function goplusScan(chain: ScanChain, address: string): Promise<ScanResult | null> {
  const r = await fetch(`/api/bot/evmscan?c=${chain.chainId}&a=${address.toLowerCase()}`);
  if (!r.ok) return null;
  const { token: t } = (await r.json()) as { token: GoPlus | null };
  if (!t) return null;
  const tax = Math.max(t.buyTax ?? 0, t.sellTax ?? 0);
  const items: [string, boolean | null][] = [
    ["It can be sold (sale simulated)", t.honeypot === null ? null : !t.honeypot && !t.cannotSellAll],
    [`Buy / sell tax under 5% (now ${t.buyTax === null ? "?" : pct(t.buyTax)} / ${t.sellTax === null ? "?" : pct(t.sellTax)})`, t.buyTax === null && t.sellTax === null ? null : tax <= 0.05],
    ["The tax can't be raised later", t.taxChangeable === null ? null : !t.taxChangeable],
    ["Nobody can create new coins", t.mintable === null ? null : !t.mintable],
    ["The owner gave up control", t.ownerRenounced],
    ["No hidden owner", t.hiddenOwner === null ? null : !t.hiddenOwner],
    ["Trading can't be paused", t.pausable === null ? null : !t.pausable],
    ["No wallet can be blocked", t.blacklist === null ? null : !t.blacklist],
    ["Its code is public", t.openSource],
    [`Top 10 wallets hold under 40%${t.top10 !== null ? ` (${pct(t.top10)})` : ""}`, t.top10 === null ? null : t.top10 <= 0.4],
    [`Creator holds under 10%${t.creatorPct !== null ? ` (${pct(t.creatorPct)})` : ""}`, t.creatorPct === null ? null : t.creatorPct <= 0.1],
    [`Liquidity is locked${t.lpLocked !== null ? ` (${pct(t.lpLocked)})` : ""}`, t.lpLocked === null ? null : t.lpLocked >= 0.9],
  ];
  const traps: string[] = [];
  if (t.honeypot || t.cannotSellAll) traps.push("Honeypot: the sale simulation failed, it may not be sellable");
  if ((t.sellTax ?? 0) > 0.15) traps.push(`A ${pct(t.sellTax ?? 0)} sell tax`);
  if (t.hiddenOwner) traps.push("It has a hidden owner");
  if (t.takeBackOwnership) traps.push("The owner can take control back");
  if (t.mintable && t.ownerRenounced === false) traps.push("The owner can print new coins");
  if ((t.creatorPct ?? 0) > 0.2) traps.push(`The creator holds ${pct(t.creatorPct ?? 0)}`);
  if ((t.top10 ?? 0) > 0.6) traps.push(`10 wallets hold ${pct(t.top10 ?? 0)}`);
  const info = t.holderCount !== null ? [`${t.holderCount.toLocaleString("en-US")} holders`] : [];
  return finish(t.name, t.symbol, items, traps, info);
}

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

function clientFor(chain: ScanChain): PublicClient | null {
  if (chain.id === "elysium") return elysiumClient();
  const x = xChain(chain.chainId);
  return x ? xClient(x) : null;
}

/** The coin's transfers: all of them when the node allows it, else the recent ones. */
async function transfers(client: PublicClient, token: Address) {
  try {
    return await client.getLogs({ address: token, event: TRANSFER, fromBlock: 0n, toBlock: "latest" });
  } catch {
    const now = await client.getBlockNumber();
    for (const span of [200_000n, 50_000n, 10_000n]) {
      try {
        return await client.getLogs({ address: token, event: TRANSFER, fromBlock: now > span ? now - span : 0n, toBlock: now });
      } catch {
        /* a smaller window */
      }
    }
    return null;
  }
}

async function onchainScan(chain: ScanChain, address: string): Promise<ScanResult | null> {
  const client = clientFor(chain);
  if (!client) return null;
  const token = getAddress(address);
  const code = await client.getCode({ address: token }).catch(() => undefined);
  if (!code || code === "0x") return null;
  const read = <T,>(functionName: "name" | "symbol" | "decimals" | "totalSupply" | "owner") =>
    client.readContract({ address: token, abi: erc20, functionName }).then((v) => v as T, () => null);
  const [name, symbol, supply, owner] = await Promise.all([read<string>("name"), read<string>("symbol"), read<bigint>("totalSupply"), read<string>("owner")]);
  if (supply === null) return null;

  // a coin launched on sasa (Elysium): fixed supply, liquidity locked forever in the launcher
  let sasa: { pool: string; creator: string } | null = null;
  if (chain.id === "elysium") {
    const c = await client.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "coins", args: [token] }).catch(() => null);
    if (c && c[1] && !/^0x0{40}$/i.test(c[1])) sasa = { pool: c[1].toLowerCase(), creator: c[2].toLowerCase() };
  }

  const code_ = code.toLowerCase();
  const mintable = sasa ? false : code_.includes("40c10f19") || code_.includes("a0712d68");
  const ownerGone = owner === null ? null : /^0x0{40}$/i.test(owner) || owner.toLowerCase() === DEAD;

  const logs = await transfers(client, token);
  const bal = new Map<string, bigint>();
  let creator = sasa?.creator ?? null;
  let creatorSold = false;
  let firstBlock: bigint | null = null;
  if (logs) {
    for (const l of logs) {
      const from = String(l.args.from).toLowerCase();
      const to = String(l.args.to).toLowerCase();
      const v = l.args.value ?? 0n;
      if (firstBlock === null) firstBlock = l.blockNumber;
      if (!creator && from === ZERO && to !== ZERO) creator = to;
      if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - v);
      bal.set(to, (bal.get(to) ?? 0n) + v);
      // the creator sending coins to a pool or anyone else (a sasa coin's pool start doesn't count)
      if (creator && from === creator && !(sasa && to === sasa.pool)) creatorSold = true;
    }
  }
  const skip = new Set([ZERO, DEAD, ELYSIUM.launcher.toLowerCase(), ...(sasa ? [sasa.pool] : [])]);
  const holders = [...bal.entries()].filter(([a, b]) => b > 0n && !skip.has(a)).sort((x, y) => (y[1] > x[1] ? 1 : -1));
  const share = (b: bigint) => (supply > 0n ? Number((b * 1_000_000n) / supply) / 1_000_000 : 0);
  const top10 = logs ? share(holders.slice(0, 10).reduce((s, [, b]) => s + b, 0n)) : null;
  const creatorPct = logs && creator ? share(bal.get(creator) ?? 0n) : null;

  let ageText: string | null = null;
  if (firstBlock !== null) {
    const b = await client.getBlock({ blockNumber: firstBlock }).catch(() => null);
    if (b) {
      const h = (Date.now() / 1000 - Number(b.timestamp)) / 3600;
      ageText = h < 1 ? `Launched ${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `Launched ${Math.round(h)} h ago` : `Launched ${Math.round(h / 24)} days ago`;
    }
  }

  const items: [string, boolean | null][] = [
    ...(sasa ? ([["Launched on sasa: fixed supply, liquidity locked forever", true]] as [string, boolean][]) : []),
    ["Nobody can create new coins", mintable ? (ownerGone === true ? true : false) : true],
    ["The owner gave up control", sasa ? null : owner === null ? true : ownerGone],
    [`Top 10 wallets hold under 40%${top10 !== null ? ` (${pct(top10)})` : ""}`, top10 === null ? null : top10 <= 0.4],
    [`Creator holds under 10%${creatorPct !== null ? ` (${pct(creatorPct)})` : ""}`, creatorPct === null ? null : creatorPct <= 0.1],
    ["The creator hasn't sold", logs && creator ? !creatorSold : null],
  ];
  const traps: string[] = [];
  if (mintable && ownerGone === false) traps.push("The owner can print new coins");
  if ((creatorPct ?? 0) > 0.2) traps.push(`The creator holds ${pct(creatorPct ?? 0)}`);
  if ((top10 ?? 0) > 0.6) traps.push(`10 wallets hold ${pct(top10 ?? 0)}`);
  const info = [
    ...(ageText ? [ageText] : []),
    ...(logs ? [`${holders.length.toLocaleString("en-US")} holders`] : ["Holders couldn't be read from this chain's node"]),
    ...(chain.goplus ? [] : ["Sale simulation isn't available on this chain yet"]),
  ];
  return finish(name, symbol, items, traps, info, !!sasa);
}

/** The safety check of `address` on `chain`, or null when it isn't a coin there. */
export async function scanCoin(chainId: string, address: string): Promise<ScanResult | null> {
  const chain = SCAN_CHAINS.find((c) => c.id === chainId);
  if (!chain || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return chain.goplus ? goplusScan(chain, address) : onchainScan(chain, address);
}
