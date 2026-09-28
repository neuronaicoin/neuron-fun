// Social API: called from functions/api/[[path]].js once the session is checked.
//   POST /api/social/profile   { username, color, emoji, bio, hideTrades } → { profile }
//   POST /api/social/follow    { address, follow }                         → { following }
import { q, sec } from "./forum-core.js";

const RESERVED = new Set([
  "admin", "sasa", "sasapad", "support", "help", "team", "official", "mod", "moderator", "root", "system",
  "api", "app", "forum", "terminal", "stats", "learn", "coin", "coins", "create", "login", "me", "u", "traders",
]);
const EMOJI = new Set(["", "🙂", "🦦", "🐸", "🚀", "🔥", "👑", "💎", "🐋", "🐶", "🐱", "🦊", "🐼", "🦍", "🌙", "⚡"]);
const COLORS = new Set(["#ff6b1a", "#8a5cf6", "#2563eb", "#12b886", "#ef4444", "#f59e0b", "#ec4899", "#0ea5e9"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);

export async function socialRoute(ctx, me, parts, method, body) {
  const env = ctx.env;
  const p = parts.slice(1);

  if (p[0] === "profile" && p.length === 1 && method === "POST") {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const color = typeof body.color === "string" ? body.color.toLowerCase() : "#ff6b1a";
    const emoji = typeof body.emoji === "string" ? body.emoji : "";
    const bio = typeof body.bio === "string" ? body.bio.replace(/\s+/g, " ").trim() : "";
    if (username && !/^[a-z0-9_]{3,20}$/.test(username)) return fail(400, "Use 3–20 letters, numbers or _ for your username.");
    if (username && (RESERVED.has(username) || /^0x/.test(username))) return fail(400, "That username isn't available.");
    if (!COLORS.has(color)) return fail(400, "Pick one of the colors.");
    if (!EMOJI.has(emoji)) return fail(400, "Pick one of the avatars.");
    if (bio.length > 140) return fail(400, "Keep the bio under 140 characters.");
    if (/https?:\/\//i.test(bio)) return fail(400, "Links aren't allowed in the bio.");
    if (username) {
      const taken = await sec(env, `profiles?username=eq.${q(username)}&address=neq.${q(me)}&select=address`);
      if (taken && taken.length) return fail(409, "That username is taken.");
    }
    const row = { address: me, username: username || null, color, emoji, bio, hide_trades: !!body.hideTrades, updated_at: new Date().toISOString() };
    try {
      const data = await sec(env, "profiles?on_conflict=address&select=address,username,color,emoji,bio,hide_trades", {
        method: "POST",
        body: row,
        prefer: "resolution=merge-duplicates,return=representation",
      });
      return json({ profile: data && data[0] });
    } catch (e) {
      if (/duplicate key|profiles_username_key/.test(e.message)) return fail(409, "That username is taken.");
      throw e;
    }
  }

  if (p[0] === "follow" && p.length === 1 && method === "POST") {
    const target = typeof body.address === "string" ? body.address.toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(target)) return fail(400, "Unknown trader.");
    if (target === me) return fail(400, "You can't follow yourself.");
    if (body.follow === false) {
      await sec(env, `follows?follower=eq.${q(me)}&followee=eq.${q(target)}`, { method: "DELETE" });
      return json({ following: false });
    }
    const mine = await sec(env, `follows?follower=eq.${q(me)}&select=followee&limit=1000`);
    if (mine && mine.length >= 1000) return fail(400, "You can follow up to 1000 traders.");
    await sec(env, "follows?on_conflict=follower,followee", {
      method: "POST",
      body: { follower: me, followee: target },
      prefer: "resolution=ignore-duplicates",
    });
    return json({ following: true });
  }

  return fail(404, "Not found.");
}
