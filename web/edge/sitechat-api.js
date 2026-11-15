// sasa Chat API (/chat/ page): called from functions/api/[[path]].js once the session is checked.
//
//   POST /api/chat   { body }  → { message, left }
//
// One public room. Plain text up to 100 characters; no links, handles, contract addresses or
// ads; 20 messages a day per account (and a cap per network, since new wallets are free);
// one message every 8 seconds; the same text twice in a row is refused. Messages older than
// 4 hours are deleted as new ones come in (indexer/sitechat.sql).
import { q, sec } from "./forum-core.js";
import { net64 } from "./ai-api.js";
import { cleanChat } from "./racechat-api.js";

const MAX = 100;
const PER_DAY = 20;
const GAP_MS = 8_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);

async function takeOne(env, who, kind, limit) {
  try {
    return (await sec(env, "rpc/ai_take", { method: "POST", body: { p_address: who, p_kind: kind, p_limit: limit } })) === true;
  } catch (e) {
    if (/ai_take|does not exist|schema cache/i.test(e.message || "")) return true;
    throw e;
  }
}

// Links in any form: schemes, www, "name.tld", "name dot com", shorteners, invite paths
const LINK =
  /(https?:|:\/\/|www\.|\b[a-z0-9-]{2,}\s*(\.|\(dot\)|\[dot\]|\sdot\s)\s*(com|io|xyz|fun|app|net|org|gg|co|me|ly|to|ai|so|sh|cc|tv|info|biz|site|online|link|club|pro|vip|bet|cash|finance|exchange|money|trade|world|live|top)\b|t\.me|telegram\.|discord\.(gg|com)|bit\.ly|linktr\.ee)/i;
// Contract addresses (coin shilling): EVM 0x… and Solana base58
const ADDRESS = /0x[0-9a-f]{20,}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i;
// Ads and contact grabs
const AD =
  /(@[a-z0-9_]{3,}|\b(dm|pm|inbox) me\b|\bjoin (my|our|us)\b|\b(telegram|whatsapp|discord|signal|wechat)\b|\b(promo|promotion|presale|pre-sale|giveaway|airdrop|whitelist|referral|ref code|use code|sponsored|guaranteed|100x gem)\b)/i;

export async function siteChatRoute(ctx, me, parts, method, body) {
  const env = ctx.env;
  if (!(parts.length === 1 && method === "POST")) return fail(404, "Not found.");
  const text = cleanChat(body.body);
  if (!text) return fail(400, "Write something first.");
  if (text.length > MAX) return fail(400, `Keep it to ${MAX} characters.`);
  if (LINK.test(text)) return fail(400, "Links aren't allowed in the chat.");
  if (ADDRESS.test(text)) return fail(400, "Contract addresses aren't allowed in the chat.");
  if (AD.test(text)) return fail(400, "No ads, handles or invites in the chat.");
  if (/(.)\1{7,}/.test(text)) return fail(400, "That looks like spam.");

  const last = await sec(env, `site_chat?author=eq.${q(me)}&select=body,created_at&order=created_at.desc&limit=1`);
  if (last.length && Date.now() - Date.parse(last[0].created_at) < GAP_MS) return fail(429, "One message every few seconds.");
  if (last.length && last[0].body.toLowerCase() === text.toLowerCase()) return fail(400, "You just said that.");

  if (!(await takeOne(env, me, "sitechat", PER_DAY))) return fail(429, `That's your ${PER_DAY} messages for today. See you tomorrow.`);
  let ip = String(ctx.request.headers.get("cf-connecting-ip") || "").slice(0, 64);
  if (ip.includes(":")) ip = net64(ip);
  if (ip && !(await takeOne(env, `ip:${ip}`, "sitechat", PER_DAY * 3))) return fail(429, "That's the chat limit for this network today.");

  const rows = await sec(env, "site_chat?select=id,author,body,created_at", {
    method: "POST",
    body: { author: me, body: text },
    prefer: "return=representation",
  });
  // keep only the last 4 hours
  const cutoff = new Date(Date.now() - 4 * 3600_000).toISOString();
  ctx.waitUntil?.(sec(env, `site_chat?created_at=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE" }).catch(() => {}));
  return json({ message: rows && rows[0] });
}
