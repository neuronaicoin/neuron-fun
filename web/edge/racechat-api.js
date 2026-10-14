// Live race chat API: called from functions/api/[[path]].js once the session is checked.
//
//   POST /api/racechat   { coinId, body }  → { message }
//
// Anyone signed in may write while the race runs and for 15 minutes after it ends.
// Short, plain text: no links, 200 characters, one message every 4 seconds, 80 a day.
import { q, sec } from "./forum-core.js";

const RACE_ID = /^0x[0-9a-f]{64}$/;
const AFTER_MS = 15 * 60_000;
const GAP_MS = 4_000;
const PER_DAY = 80;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);

export function cleanChat(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function raceChatRoute(env, me, parts, method, body) {
  if (!(parts.length === 1 && method === "POST")) return fail(404, "Not found.");
  const coinId = typeof body.coinId === "string" ? body.coinId.toLowerCase() : "";
  if (!RACE_ID.test(coinId)) return fail(400, "Unknown race.");
  const text = cleanChat(body.body);
  if (!text) return fail(400, "Write something first.");
  if (text.length > 200) return fail(400, "Keep it under 200 characters.");
  if (/https?:\/\/|www\.|\.(com|io|xyz|fun|app|net|org)\b|t\.me\//i.test(text)) return fail(400, "Links aren't allowed in the race chat.");

  const races = await sec(env, `race_coins?id=eq.${q(coinId)}&select=ends_at,decided_at`);
  if (!races.length) return fail(404, "Unknown race.");
  const ends = Date.parse(races[0].decided_at || races[0].ends_at);
  if (Number.isFinite(ends) && Date.now() > ends + AFTER_MS) return fail(403, "The chat closed after the race.");

  const since = new Date(Date.now() - 86400e3).toISOString();
  const [last, today] = await Promise.all([
    sec(env, `race_chat?author=eq.${q(me)}&select=created_at&order=created_at.desc&limit=1`),
    sec(env, `race_chat?author=eq.${q(me)}&created_at=gt.${q(since)}&select=id&limit=${PER_DAY}`),
  ]);
  if (last.length && Date.now() - Date.parse(last[0].created_at) < GAP_MS) return fail(429, "One message every few seconds.");
  if (today.length >= PER_DAY) return fail(429, "You've reached today's chat limit.");

  const rows = await sec(env, "race_chat?select=id,coin_id,author,body,created_at", {
    method: "POST",
    body: { coin_id: coinId, author: me, body: text },
    prefer: "return=representation",
  });
  return json({ message: rows && rows[0] });
}
