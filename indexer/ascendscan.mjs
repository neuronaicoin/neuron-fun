/**
 * Ascend testnet scan: who launched and who bought on Ascend (Elysium testnet), earliest and most
 * active first. Read-only, public chain data from the Elysium explorer (Blockscout API v2), nothing
 * signed. Writes indexer/ascend-watch.json (the mainnet radar's watch list) and a readable summary.
 *
 *   node ascendscan.mjs [launchpad address]
 *
 * Public chain data shows what a wallet did, not who owns it: the list is wallets to watch, nothing more.
 */
import { writeFileSync, appendFileSync } from "node:fs";

const API = process.env.ELY_API || "https://testnet-api.elysium.kinetiq.xyz/api/v2";
const LAUNCHPAD = (process.argv[2] || process.env.ASCEND_LAUNCHPAD || "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9").toLowerCase();
const OUT = new URL("./ascend-watch.json", import.meta.url);
const EARLY_MIN = 10; // a buy in a coin's first 10 minutes counts as early
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const url = `${API}${path}${q.size ? "?" + q : ""}`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 4) throw new Error(`${url}: ${e.message}`);
      await sleep(800 * (i + 1));
    }
  }
}

/** Every page of a Blockscout list (up to `max` pages). */
async function all(path, params = {}, max = 200) {
  const items = [];
  let next = null;
  for (let p = 0; p < max; p++) {
    const r = await get(path, { ...params, ...(next || {}) });
    if (!r) break;
    items.push(...(r.items || []));
    next = r.next_page_params;
    if (!next) break;
    await sleep(120);
  }
  return items;
}

const lc = (a) => (typeof a === "string" ? a.toLowerCase() : a?.hash?.toLowerCase());
const ts = (t) => (t ? Date.parse(t) : null);

// ---------------------------------------------------------------- 1. launches
console.log(`Ascend launchpad ${LAUNCHPAD}`);
const logs = await all(`/addresses/${LAUNCHPAD}/logs`);
const launchLogs = logs.filter((l) => /^Launched/i.test(l.decoded?.method_call || ""));
console.log(`${logs.length} logs, ${launchLogs.length} launches`);
if (!launchLogs.length && logs.length) console.log("Event names seen:", [...new Set(logs.map((l) => l.decoded?.method_call?.split("(")[0] || l.topics?.[0]))].slice(0, 10));

const tokenInfo = new Map(); // address -> token json | null
async function isToken(a) {
  if (!tokenInfo.has(a)) tokenInfo.set(a, await get(`/tokens/${a}`).catch(() => null));
  return tokenInfo.get(a);
}

const launches = [];
for (const l of launchLogs) {
  const addrs = (l.decoded?.parameters || []).filter((p) => p.type === "address").map((p) => lc(p.value));
  let token = null;
  for (const a of addrs) if (a && a !== LAUNCHPAD && (await isToken(a))?.type === "ERC-20") (token = a);
  if (!token) continue;
  const tx = await get(`/transactions/${l.transaction_hash || l.tx_hash}`);
  const info = tokenInfo.get(token);
  launches.push({ token, symbol: info?.symbol || "?", name: info?.name || "?", launcher: lc(tx?.from), at: ts(tx?.timestamp), holders: Number(info?.holders_count || info?.holders || 0) });
  await sleep(100);
}
console.log(`${launches.length} coins found`);

// ---------------------------------------------------------------- 2. buyers per coin
// Buys are the coin moving out of its pool. On Ascend (a Uniswap v4 hook) every pool's coins sit in
// the one PoolManager, so the address that sends a coin out the most is the pool.
const wallets = new Map();
const W = (a) => {
  if (!wallets.has(a)) wallets.set(a, { address: a, launched: [], bought: new Set(), buys: 0, early: 0, first3: 0, firstSeen: null, funder: null });
  return wallets.get(a);
};
const seen = (w, t) => t && (w.firstSeen === null || t < w.firstSeen) && (w.firstSeen = t);

for (const c of launches) {
  if (c.launcher) {
    const w = W(c.launcher);
    w.launched.push(c.symbol);
    seen(w, c.at);
  }
  const tr = (await all(`/tokens/${c.token}/transfers`, {}, 40)).filter((t) => lc(t.from) && lc(t.to));
  const outCount = new Map();
  for (const t of tr) outCount.set(lc(t.from), (outCount.get(lc(t.from)) || 0) + 1);
  const skip = new Set([LAUNCHPAD, c.token, "0x0000000000000000000000000000000000000000"]);
  const pool = [...outCount.entries()].filter(([a]) => !skip.has(a)).sort((a, b) => b[1] - a[1])[0]?.[0];
  const buys = tr.filter((t) => lc(t.from) === pool && !skip.has(lc(t.to)) && lc(t.to) !== pool).sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
  c.buys = buys.length;
  c.pool = pool;
  const start = c.at ?? ts(buys[0]?.timestamp);
  const order = [];
  for (const b of buys) {
    const a = lc(b.to);
    const w = W(a);
    w.buys++;
    w.bought.add(c.symbol);
    const t = ts(b.timestamp);
    seen(w, t);
    if (start && t && t - start <= EARLY_MIN * 60_000) w.early++;
    if (!order.includes(a)) order.push(a);
  }
  for (const a of order.slice(0, 3)) W(a).first3++;
  process.stdout.write(".");
  await sleep(100);
}
console.log("");

// ---------------------------------------------------------------- 3. score, then who funded the top ones
const list = [...wallets.values()].map((w) => ({ ...w, bought: [...w.bought], score: w.launched.length * 3 + w.first3 * 3 + w.early * 2 + w.bought.size }));
list.sort((a, b) => b.score - a.score || (a.firstSeen ?? Infinity) - (b.firstSeen ?? Infinity));
const top = list.slice(0, 150);
for (const w of top) {
  // the first wallet that ever sent this one HYPE
  const inc = (await all(`/addresses/${w.address}/transactions`, { filter: "to" }, 6)).filter((t) => BigInt(t.value || "0") > 0n);
  const first = inc.sort((a, b) => ts(a.timestamp) - ts(b.timestamp))[0];
  w.funder = lc(first?.from) || null;
  await sleep(100);
}
// a funder that fed dozens of wallets is a faucet or exchange, not a team
const fed = new Map();
for (const w of top) if (w.funder) fed.set(w.funder, [...(fed.get(w.funder) || []), w.address]);
const groups = [...fed.entries()].filter(([, ws]) => ws.length >= 2 && ws.length <= 25).map(([funder, ws]) => ({ funder, wallets: ws })).sort((a, b) => b.wallets.length - a.wallets.length);
for (const g of groups) for (const a of g.wallets) top.find((w) => w.address === a).group = g.funder;

const out = {
  scannedAt: new Date().toISOString(),
  launchpad: LAUNCHPAD,
  coins: launches.sort((a, b) => b.buys - a.buys),
  wallets: top.map(({ address, launched, bought, buys, early, first3, firstSeen, funder, group, score }) => ({ address, score, launched, boughtCoins: bought.length, buys, early, first3, firstSeen: firstSeen ? new Date(firstSeen).toISOString() : null, funder, group: group || null })),
  groups,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
let md = `## Ascend testnet scan\n\n${launches.length} coins, ${wallets.size} wallets. Top 30 to watch on mainnet:\n\n| # | Wallet | Score | Launched | Coins bought | Early buys | First 3 | Funded by | Group |\n|---|---|---|---|---|---|---|---|---|\n`;
out.wallets.slice(0, 30).forEach((w, i) => (md += `| ${i + 1} | \`${w.address}\` | ${w.score} | ${w.launched.join(", ") || "–"} | ${w.boughtCoins} | ${w.early} | ${w.first3} | ${short(w.funder)} | ${w.group ? short(w.group) : ""} |\n`));
md += `\n**Wallet groups (same first funder):** ${groups.length}\n\n` + groups.slice(0, 15).map((g) => `- ${short(g.funder)} funded ${g.wallets.length}: ${g.wallets.map(short).join(", ")}`).join("\n");
md += `\n\n**Most-bought coins:** ` + out.coins.slice(0, 15).map((c) => `${c.symbol} (${c.buys})`).join(", ") + "\n";
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
