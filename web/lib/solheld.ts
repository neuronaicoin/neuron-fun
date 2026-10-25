/**
 * Solana coins the user holds, for "You" and the balance total (only for people who see
 * Solana: lib/solana.ts). Light on purpose (plain calls to sasa's Solana node, no Solana
 * libraries): every coin in the user's Solana wallet, priced from sasa's Solana list.
 *
 * Which Solana wallet belongs to which sasa account is remembered on this device the moment
 * it's known (rememberSolWallet), so the balance shows it on every page.
 */
import { db } from "./data";
import { toExt, extHref } from "./extcoins";
import { SOLANA_ID, SOL_RPC, solanaFor } from "./solana";
import type { ExtHolding } from "./extheld";

const KEY = (evm: string) => `sasa.solwallet.${evm.toLowerCase()}`;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export function rememberSolWallet(evm: string, sol: string) {
  if (!B58.test(sol)) return;
  try {
    localStorage.setItem(KEY(evm), sol);
  } catch {}
}
export function solWalletOf(evm: string): string | null {
  try {
    const v = localStorage.getItem(KEY(evm));
    return v && B58.test(v) ? v : null;
  } catch {
    return null;
  }
}

type Parsed = { account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null; uiAmountString?: string } } } } } };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (!r.ok || j.error || j.result === undefined) throw new Error(j.error?.message ?? `Solana ${r.status}`);
  return j.result;
}

/** Every Solana coin in the wallet of sasa account `evm` (dust and unpriced zero left out). */
export async function fetchSolHoldings(evm: string): Promise<ExtHolding[]> {
  if (!solanaFor(evm)) return [];
  const owner = solWalletOf(evm);
  if (!owner) return [];
  const amounts = new Map<string, number>();
  for (const programId of PROGRAMS) {
    const res = await rpc<{ value: Parsed[] }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const a of res.value) {
      const info = a.account.data.parsed?.info;
      const mint = info?.mint;
      const n = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0);
      if (mint && B58.test(mint) && n > 0) amounts.set(mint, (amounts.get(mint) ?? 0) + n);
    }
  }
  if (!amounts.size) return [];
  const mints = [...amounts.keys()].slice(0, 100);
  const [market, ours] = await Promise.all([
    db.from("sol_ext_coins_all").select("*").in("address", mints),
    // coins launched on sasa: priced from their launch curve before DexScreener has them
    db.from("sol_sasa_coins").select("*").in("address", mints),
  ]);
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of ((ours.error ? [] : ours.data) ?? []) as Record<string, unknown>[]) rows.set(String(r.address), r);
  // market numbers win, but never wipe out what the market list lacks (a sasa coin's picture)
  for (const r of (market.data ?? []) as Record<string, unknown>[]) {
    const k = String(r.address);
    if (rows.has(k) && !r.price_usd) continue;
    const merged: Record<string, unknown> = { ...rows.get(k) };
    for (const [f, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== "") merged[f] = v;
    rows.set(k, merged);
  }
  const out: ExtHolding[] = [];
  for (const r of rows.values()) {
    const e = toExt(r);
    const tokens = amounts.get(e.address) ?? 0;
    const valueUsd = e.priceUsd ? tokens * e.priceUsd : 0;
    if (tokens <= 0 || (e.priceUsd && valueUsd < 0.01)) continue; // dust
    out.push({
      network: "solana",
      chainId: SOLANA_ID,
      address: e.address,
      name: e.name,
      symbol: e.symbol,
      image: e.image,
      tokens,
      priceUsd: e.priceUsd,
      valueUsd,
      change24h: e.change24h,
      href: extHref({ network: "solana", address: e.address }),
    });
  }
  return out;
}

/**
 * A buy or launch that is moving SOL into the Solana wallet right now (on this device): the
 * "back to Cash" helper leaves the wallet alone meanwhile, or it would send that SOL back
 * before it's used. Expires by itself after 10 minutes.
 */
const INFLIGHT = "sasa.sol.inflight";
export function solInflight(on: boolean) {
  try {
    if (on) localStorage.setItem(INFLIGHT, String(Date.now()));
    else localStorage.removeItem(INFLIGHT);
  } catch {}
}
export function solIsInflight(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(INFLIGHT) || 0) < 600_000;
  } catch {
    return false;
  }
}
