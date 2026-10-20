// Posts every new race and every race result to sasa's Telegram channel, so the channel is
// always alive. Runs inside the race keeper when TG_POST_TOKEN is set.
//
// Env (Railway → race-keeper → Variables):
//   TG_POST_TOKEN   the bot's token from @BotFather (the bot must be an admin of the channel)
//   TG_POST_CHAT    where to post, default "@sasapadfun"
//   SUPABASE_URL    already set for alerts
// Reads the public race tables only. Posts only what happens after the keeper starts
// (a restart never re-posts old races).

const SITE = "https://sasapad.fun";
const CHAINS = { 8453: "Base", 56: "BNB Chain", 4663: "Robinhood", 5042: "Arc" };
const EVERY_MS = 20_000;
const PUBLIC_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] tg: ${m}`);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v < 10 ? v.toFixed(2) : Math.round(v)}`);

function list(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The launch post. Exported for tests. */
export function launchText(c) {
  const order = [8453, 56, 4663, 5042];
  const chains = (c.race_chains ?? []).map((l) => l.chain_id).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((id) => CHAINS[id]).filter(Boolean);
  const where = chains.length > 1 ? `live on ${list(chains)} at the same time` : `live on ${chains[0] ?? "sasa"}`;
  const race = chains.length > 1 ? "5 min race, the chain with the most money takes all the liquidity" : "trading now";
  return `new coin just dropped 🏁\n\n<b>${esc(c.name)}</b> ($${esc(c.symbol)})\n${where}. ${race}\n\npick your side 👇\n${SITE}/r/?id=${c.id}`;
}

/** The result post. Exported for tests. */
export function resultText(c) {
  const win = CHAINS[c.winner_chain] ?? "one chain";
  const lanes = c.race_chains ?? [];
  const total = lanes.reduce((s, l) => s + Number(l.pool_usd ?? 0) + Number(l.merged_usd ?? 0), 0);
  const losers = lanes.filter((l) => l.chain_id !== c.winner_chain).length;
  const merged = losers > 0 ? `, the other ${losers === 1 ? "chain" : `${losers} chains`} hand their money over to it` : "";
  const money = total >= 1 ? `${usd(total)} raised in the race${merged}` : `the race is over${merged}`;
  return `🏆 <b>${win}</b> won the $${esc(c.symbol)} race\n\n${money}\n\n${SITE}/r/?id=${c.id}`;
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `HTTP ${r.status}`);
  return j;
}

async function post(token, chat, text, photo) {
  // coin pictures are stored inline (data:image/...;base64): upload the file itself
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/.exec(photo ?? "");
  if (m) {
    try {
      const form = new FormData();
      form.set("chat_id", chat);
      form.set("caption", text);
      form.set("parse_mode", "HTML");
      form.set("photo", new Blob([Buffer.from(m[3], "base64")], { type: m[1] }), `coin.${m[2] === "jpeg" ? "jpg" : m[2]}`);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return j;
    } catch {}
  }
  if (photo && /^https:\/\//.test(photo)) {
    try {
      return await tg(token, "sendPhoto", { chat_id: chat, photo, caption: text, parse_mode: "HTML" });
    } catch {
      // a picture Telegram can't fetch: the text alone
    }
  }
  return tg(token, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: false } });
}

async function recent(since) {
  const base = process.env.SUPABASE_URL || "https://rkoassatqhdkdptekvdt.supabase.co";
  const q = new URLSearchParams({
    select: "id,name,symbol,logo,launched_at,winner_chain,decided_at,race_chains(chain_id,pool_usd,merged_usd)",
    or: `(launched_at.gte.${since},decided_at.gte.${since})`,
    order: "launched_at.asc",
    limit: "100",
  });
  const r = await fetch(`${base}/rest/v1/race_coins?${q}`, { headers: { apikey: PUBLIC_KEY }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`race_coins ${r.status}`);
  return r.json();
}

export async function startTgPosts() {
  const token = process.env.TG_POST_TOKEN;
  if (!token) return;
  const chat = process.env.TG_POST_CHAT || "@sasapadfun";
  const started = new Date().toISOString();
  const launched = new Set();
  const decided = new Set();
  // races already in the table when the keeper starts are never posted
  for (const c of await recent(new Date(Date.now() - 86_400_000).toISOString()).catch(() => [])) {
    launched.add(c.id);
    if (c.winner_chain) decided.add(c.id);
  }
  log(`posting new races and results to ${chat}`);
  for (;;) {
    try {
      for (const c of await recent(started)) {
        if (!launched.has(c.id)) {
          launched.add(c.id);
          await post(token, chat, launchText(c), c.logo);
          log(`launch posted: ${c.symbol}`);
          await sleep(1500);
        }
        if (c.winner_chain && !decided.has(c.id)) {
          decided.add(c.id);
          await post(token, chat, resultText(c));
          log(`result posted: ${c.symbol}`);
          await sleep(1500);
        }
      }
    } catch (e) {
      log(`post failed: ${e?.message ?? e}`);
    }
    await sleep(EVERY_MS);
  }
}
