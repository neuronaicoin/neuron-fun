// Elysium Radar: a private Telegram alert whenever a watched wallet (the people around Ascend,
// Kinetiq and Hyperliquid) launches a coin, buys one or sells one, and whenever a known
// "distributor" wallet funds a new wallet (a new insider: from then on it's watched too).
// When two or more watched wallets buy the same coin, the alert says STRONG.
//
// Starting list: indexer/ascend-watch.json (the Ascend testnet scan) minus Ascend's own test bots,
// plus RADAR_WATCH. New wallets found later are kept in the radar_watch table.
//
// Read-only: public chain data (RPC) and the explorer (Blockscout API). Nothing is signed.
//
// Env (Railway → indexer → Variables):
//   TG_RADAR_TOKEN   bot that sends the alerts (default: TG_POST_TOKEN, the whale bot)
//   TG_RADAR_CHAT    who gets them (default 178588677, a private chat: /start the bot first)
//   ELY_RADAR_RPC    chain RPC (default: Elysium testnet)        ← set the mainnet one on Nov 9
//   ELY_RADAR_API    explorer API v2 (default: Elysium testnet)  ← and this
//   ELY_RADAR_EXPLORER explorer site for links (default: Elysium testnet)
//   ASCEND_LAUNCHPAD Ascend's launchpad contract (default: the testnet one) ← and this
//   RADAR_FUNDERS    extra distributor wallets, comma separated
//   RADAR_WATCH      extra wallets to watch: "0xabc…:Kinetiq treasury,0xdef…:Ascend founder"
//   RADAR_OFF=1      switch off

import { readFileSync } from "node:fs";

const RPC = process.env.ELY_RADAR_RPC || "https://testnet-rpc.elysium.kinetiq.xyz";
const API = process.env.ELY_RADAR_API || "https://testnet-api.elysium.kinetiq.xyz/api/v2";
const EXPLORER = (process.env.ELY_RADAR_EXPLORER || "https://elysium.kinetiq.xyz/testnet-explorer").replace(/\/$/, "");
const LAUNCHPAD = (process.env.ASCEND_LAUNCHPAD || "0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9").toLowerCase();
const TOKEN = () => process.env.TG_RADAR_TOKEN || process.env.TG_POST_TOKEN;
const CHAT = () => process.env.TG_RADAR_CHAT || "178588677";
const NET = /testnet/i.test(RPC) ? "testnet" : "mainnet";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
/** Ascend's own test bots and a sniper-bot test: they buy everything, so they say nothing. */
const NOISY = new Set(["0x4230c7c1fff6cc8f04ddb4d797faf4e135660e3d", "0x1ef5e8bd5f999de3a9213203892da191e48f328f"]);
/** Wallets that handed test funds to Ascend's invited testers (from the scan). */
const FUNDERS = new Set(
  ["0xf272cc84c3ba9f1b498ade29aaeed1e7d2d9f3fd", "0x9e7e2c8c554a9c000b635380baeb892455c2587f", ...(process.env.RADAR_FUNDERS || "").split(",")]
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
);
/** Coins that are money, not picks (what people pay with). */
const QUOTE = /^(W?HYPE|k?HYPE|USD.*|.*USD|USDT0|WETH|ETH)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const unpad = (t) => "0x" + t.slice(-40).toLowerCase();

let rpcId = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function api(path) {
  const r = await fetch(API + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- telegram (one message every 1.5 s)
const outbox = [];
let sending = false;
function send(html) {
  if (!TOKEN()) return;
  outbox.push(html);
  if (outbox.length > 40) outbox.splice(0, outbox.length - 40);
  if (!sending) void drain();
}
async function drain() {
  sending = true;
  while (outbox.length) {
    const text = outbox.shift();
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT(), text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Telegram unreachable: drop it, the next alert still goes
    }
    await sleep(1500);
  }
  sending = false;
}
const addrLink = (a, label) => `<a href="${EXPLORER}/address/${a}">${esc(label || short(a))}</a>`;
const tokenLink = (t) => `<a href="${EXPLORER}/token/${t.address}">$${esc(t.symbol)}</a>`;

// ---------------------------------------------------------------- what we know
const watch = new Map(); // address -> label
const isContract = new Map();
const tokens = new Map(); // address -> { address, symbol, name, decimals }
/** coin -> Map(wallet -> first buy time): who of ours is in it */
const buyers = new Map();

async function codeAt(a) {
  if (!isContract.has(a)) isContract.set(a, ((await rpc("eth_getCode", [a, "latest"]).catch(() => "0x")) || "0x").length > 2);
  return isContract.get(a);
}
async function tokenOf(a) {
  if (tokens.has(a)) return tokens.get(a);
  let t = { address: a, symbol: "?", name: "?", decimals: 18, holders: null };
  try {
    const j = await api(`/tokens/${a}`);
    t = { address: a, symbol: j.symbol || "?", name: j.name || "?", decimals: Number(j.decimals ?? 18), holders: Number(j.holders_count ?? j.holders ?? 0) || null };
  } catch {
    // explorer busy: show the address
  }
  tokens.set(a, t);
  return t;
}
const amount = (raw, dec) => {
  const v = Number(BigInt(raw)) / 10 ** dec;
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
};

function seed() {
  const add = (a, label) => {
    a = String(a || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a) && !NOISY.has(a) && !watch.has(a)) watch.set(a, label);
  };
  try {
    const j = JSON.parse(readFileSync(new URL("./ascend-watch.json", import.meta.url), "utf8"));
    const noisyGroup = new Set(j.wallets.filter((w) => NOISY.has(w.funder)).map((w) => w.address));
    for (const c of j.coins || []) if (c.launcher && !NOISY.has(c.launcher)) add(c.launcher, `${c.symbol} dev`);
    for (const w of j.wallets || []) {
      if (noisyGroup.has(w.address)) continue;
      if (FUNDERS.has(w.funder)) add(w.address, "Ascend invited tester");
      else if (w.score >= 10) add(w.address, "early Ascend wallet");
    }
  } catch {
    // no scan file: only the env list
  }
  for (const f of FUNDERS) add(f, "Ascend distributor");
  for (const part of (process.env.RADAR_WATCH || "").split(",")) {
    const [a, ...rest] = part.split(":");
    add(a?.trim(), rest.join(":").trim() || "watched");
  }
}

// ---------------------------------------------------------------- the loop
export async function elyRadarLoop(pool, log) {
  if (process.env.RADAR_OFF === "1") return;
  if (!TOKEN()) {
    log("radar: no TG_RADAR_TOKEN / TG_POST_TOKEN, off");
    return;
  }
  await pool.query(`
    create table if not exists radar_watch (address text primary key, label text not null, added_at timestamptz not null default now());
    alter table radar_watch enable row level security;
    revoke all on radar_watch from anon, authenticated;`);
  seed();
  for (const r of (await pool.query("select address, label from radar_watch")).rows) if (!watch.has(r.address)) watch.set(r.address, r.label);
  const remember = (a, label) => {
    watch.set(a, label);
    pool.query("insert into radar_watch (address, label) values ($1, $2) on conflict (address) do nothing", [a, label]).catch(() => {});
  };

  let last = Number(await rpc("eth_blockNumber"));
  log(`radar: ${NET}, watching ${watch.size} wallets from block ${last}`);
  send(`🛰 <b>Elysium Radar on</b> (${NET})\nWatching ${watch.size} wallets: Ascend's invited testers, coin devs and ${FUNDERS.size} distributor wallets.`);

  const fundersSeen = new Map(); // funder -> newest tx hash already looked at
  let lastFunding = 0;

  for (;;) {
    const t0 = Date.now();
    try {
      const tip = Number(await rpc("eth_blockNumber"));
      if (tip > last) {
        const from = last + 1;
        const to = Math.min(tip, from + 499);
        const hex = (n) => "0x" + n.toString(16);
        const list = [...watch.keys()];

        // 1. launches on Ascend by anyone we watch
        const launches = await rpc("eth_getLogs", [{ address: LAUNCHPAD, fromBlock: hex(from), toBlock: hex(to) }]).catch(() => []);
        const seenTx = new Set();
        for (const l of launches) {
          if (seenTx.has(l.transactionHash)) continue;
          seenTx.add(l.transactionHash);
          const tx = await rpc("eth_getTransactionByHash", [l.transactionHash]).catch(() => null);
          const dev = tx?.from?.toLowerCase();
          if (!dev || !watch.has(dev)) continue;
          const rc = await rpc("eth_getTransactionReceipt", [l.transactionHash]).catch(() => null);
          const mint = rc?.logs?.find((x) => x.topics?.[0] === TRANSFER && x.topics[1] === pad(ZERO));
          const coin = mint ? await tokenOf(mint.address.toLowerCase()) : null;
          if (coin && QUOTE.test(coin.symbol)) continue;
          send(`🚀 <b>Watched wallet launched a coin</b>\n${coin ? `${tokenLink(coin)} ${esc(coin.name)}` : "a new coin"}\nby ${addrLink(dev, watch.get(dev))}\n\n${coin ? `<code>${coin.address}</code>` : ""}`);
        }

        // 2. buys and sells by watched wallets (ERC-20 transfers to / from them)
        for (let i = 0; i < list.length; i += 40) {
          const part = list.slice(i, i + 40).map(pad);
          const [ins, outs] = await Promise.all([
            rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER, null, part] }]).catch(() => []),
            rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER, part, null] }]).catch(() => []),
          ]);
          for (const l of ins) {
            const who = unpad(l.topics[2]);
            const src = unpad(l.topics[1]);
            if (src === ZERO || !(await codeAt(src))) continue; // a mint or a wallet-to-wallet move, not a buy
            const coin = await tokenOf(l.address.toLowerCase());
            if (QUOTE.test(coin.symbol)) continue;
            const inIt = buyers.get(coin.address) ?? new Map();
            const fresh = !inIt.has(who);
            if (fresh) inIt.set(who, Date.now());
            buyers.set(coin.address, inIt);
            if (!fresh) continue; // their second buy of the same coin says nothing new
            const n = inIt.size;
            const head = n >= 3 ? "🔥🔥 <b>STRONG: " + n + " watched wallets in</b>" : n === 2 ? "🔥 <b>STRONG: 2 watched wallets in</b>" : "👀 <b>Watched wallet bought</b>";
            send(
              `${head}\n${tokenLink(coin)} ${esc(coin.name)}${coin.holders ? ` · ${coin.holders} holders` : ""}\n${addrLink(who, watch.get(who))} got ${amount(l.data, coin.decimals)}` +
                (n >= 2 ? `\nAlso in: ${[...inIt.keys()].filter((a) => a !== who).slice(0, 4).map((a) => addrLink(a, watch.get(a))).join(", ")}` : "") +
                `\n\n<code>${coin.address}</code>`
            );
          }
          for (const l of outs) {
            const who = unpad(l.topics[1]);
            const dst = unpad(l.topics[2]);
            if (dst === ZERO || !(await codeAt(dst))) continue;
            const coin = await tokenOf(l.address.toLowerCase());
            if (QUOTE.test(coin.symbol)) continue;
            send(`🔻 <b>Watched wallet sold</b>\n${tokenLink(coin)} ${esc(coin.name)}\n${addrLink(who, watch.get(who))} sold ${amount(l.data, coin.decimals)}\n\n<code>${coin.address}</code>`);
          }
        }
        last = to;
      }

      // 3. once a minute: did a distributor fund a new wallet? (a new insider)
      if (Date.now() - lastFunding > 60_000) {
        lastFunding = Date.now();
        for (const f of FUNDERS) {
          const j = await api(`/addresses/${f}/transactions?filter=from`).catch(() => null);
          const items = (j?.items || []).filter((t) => BigInt(t.value || "0") > 0n && t.to?.hash);
          const seenHash = fundersSeen.get(f);
          fundersSeen.set(f, items[0]?.hash ?? seenHash ?? null);
          if (seenHash === undefined) continue; // first look: only remember where we are
          for (const t of items) {
            if (t.hash === seenHash) break;
            const to = t.to.hash.toLowerCase();
            if (watch.has(to) || t.to.is_contract) continue;
            remember(to, `funded by ${watch.get(f) || short(f)}`);
            send(`🆕 <b>New wallet funded by a distributor</b>\n${addrLink(f, watch.get(f))} → ${addrLink(to)}\nWatching it from now on (${watch.size} wallets).`);
          }
          await sleep(500);
        }
      }
    } catch (e) {
      log(`radar: ${e.message}`);
      await sleep(10_000);
    }
    await sleep(Math.max(0, 4000 - (Date.now() - t0)));
  }
}
