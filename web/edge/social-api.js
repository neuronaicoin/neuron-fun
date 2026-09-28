// Social API: called from functions/api/[[path]].js once the session is checked.
//   POST /api/social/profile   { username, color, emoji, bio, hideTrades } → { profile }
//   POST /api/social/follow    { address, follow }                         → { following }
//   Copy trading (see indexer/copy.sql):
//   POST /api/social/allow-copy    { on }                                  → { allowCopy }
//   POST /api/social/copy          { trader, on, mode, amount, copySells } → { copying }
//   POST /api/social/copy-list     {}                                      → { copying, results }
//   POST /api/social/signals       {}                                      → { signals, coins }
//   POST /api/social/signal        { id, action: "apply"|"reject", tx? }   → { ok }
import { admins, q, sec } from "./forum-core.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const MAX_AVATAR = 200 * 1024;

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

  // Profile picture: { image: "data:image/webp;base64,…" } or { image: null } to remove it.
  if (p[0] === "avatar" && p.length === 1 && method === "POST") {
    const base = env.SUPABASE_URL || SUPABASE_URL;
    if (body.image === null) {
      await sec(env, `profiles?address=eq.${q(me)}`, { method: "PATCH", body: { avatar_url: null } });
      return json({ avatar: null });
    }
    const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.image === "string" ? body.image : "");
    if (!m) return fail(400, "Use a JPG, PNG or WebP picture.");
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_AVATAR) return fail(400, "That picture is too big. Try a smaller one.");
    const ext = m[1] === "image/png" ? "png" : m[1] === "image/jpeg" ? "jpg" : "webp";
    const file = `${me}-${Date.now()}.${ext}`;
    const key = env.SUPABASE_SERVICE_KEY;
    const headers = { apikey: key, "content-type": m[1], "x-upsert": "true", "cache-control": "31536000" };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const up = await fetch(`${base}/storage/v1/object/avatars/${file}`, { method: "POST", headers, body: bytes });
    if (!up.ok) return fail(500, "Couldn't upload the picture. Try again.");
    const url = `${base}/storage/v1/object/public/avatars/${file}`;
    // Make sure a profile row exists, then point it at the new picture.
    await sec(env, "profiles?on_conflict=address", {
      method: "POST",
      body: { address: me },
      prefer: "resolution=ignore-duplicates",
    });
    await sec(env, `profiles?address=eq.${q(me)}`, { method: "PATCH", body: { avatar_url: url, updated_at: new Date().toISOString() } });
    return json({ avatar: url });
  }

  // Report someone's picture (3 reports remove it) or, for admins, remove it now.
  if (p[0] === "avatar-report" && p.length === 1 && method === "POST") {
    const target = typeof body.address === "string" ? body.address.toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(target) || target === me) return fail(400, "Unknown profile.");
    if (admins(env).includes(me)) {
      await sec(env, `profiles?address=eq.${q(target)}`, { method: "PATCH", body: { avatar_url: null } });
      return json({ removed: true });
    }
    await sec(env, "rpc/report_avatar", { method: "POST", body: { p_address: target, p_reporter: me } });
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- copy trading

  if (p[0] === "allow-copy" && p.length === 1 && method === "POST") {
    const on = body.on === true;
    await sec(env, "profiles?on_conflict=address", { method: "POST", body: { address: me }, prefer: "resolution=ignore-duplicates" });
    const cur = await sec(env, `profiles?address=eq.${q(me)}&select=hide_trades`);
    if (on && cur && cur[0] && cur[0].hide_trades) return fail(400, "Your trades are hidden. Show them first, so followers can see what they copy.");
    await sec(env, `profiles?address=eq.${q(me)}`, { method: "PATCH", body: { allow_copy: on, updated_at: new Date().toISOString() } });
    return json({ allowCopy: on });
  }

  if (p[0] === "copy" && p.length === 1 && method === "POST") {
    const trader = typeof body.trader === "string" ? body.trader.toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(trader)) return fail(400, "Unknown trader.");
    if (trader === me) return fail(400, "You can't copy yourself.");
    if (body.on === false) {
      await sec(env, `copy_follows?follower=eq.${q(me)}&trader=eq.${q(trader)}`, { method: "DELETE" });
      await sec(env, `copy_signals?follower=eq.${q(me)}&trader=eq.${q(trader)}&status=eq.pending`, {
        method: "PATCH",
        body: { status: "expired", acted_at: new Date().toISOString() },
      });
      return json({ copying: null });
    }
    const t = await sec(env, `profiles?address=eq.${q(trader)}&select=allow_copy,hide_trades`);
    if (!t || !t[0] || !t[0].allow_copy || t[0].hide_trades) return fail(400, "This trader doesn't allow copying.");
    const mode = body.mode === "pct" ? "pct" : "fixed";
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(400, "Enter an amount above 0.");
    if (mode === "pct" && amount > 1000) return fail(400, "Pick a share up to 1000%.");
    if (mode === "fixed" && amount > 100000) return fail(400, "That amount is too big.");
    const mine = await sec(env, `copy_follows?follower=eq.${q(me)}&select=trader&limit=100`);
    if (mine && mine.length >= 50 && !mine.some((r) => r.trader === trader)) return fail(400, "You can copy up to 50 traders.");
    const row = { follower: me, trader, mode, amount, copy_sells: body.copySells !== false, updated_at: new Date().toISOString() };
    const data = await sec(env, "copy_follows?on_conflict=follower,trader&select=trader,mode,amount,copy_sells", {
      method: "POST",
      body: row,
      prefer: "resolution=merge-duplicates,return=representation",
    });
    // Copying someone means following them too.
    await sec(env, "follows?on_conflict=follower,followee", {
      method: "POST",
      body: { follower: me, followee: trader },
      prefer: "resolution=ignore-duplicates",
    });
    return json({ copying: data && data[0] });
  }

  if (p[0] === "copy-list" && p.length === 1 && method === "POST") {
    const [copying, results] = await Promise.all([
      sec(env, `copy_follows?follower=eq.${q(me)}&select=trader,mode,amount,copy_sells,created_at&order=created_at.desc`),
      sec(env, "rpc/my_copy_results", { method: "POST", body: { p_follower: me } }),
    ]);
    return json({ copying: copying || [], results: results || [] });
  }

  if (p[0] === "signals" && p.length === 1 && method === "POST") {
    const signals =
      (await sec(
        env,
        `copy_signals?follower=eq.${q(me)}&status=neq.expired&select=id,trader,coin_id,chain_id,curve,is_buy,trader_native,trader_price,trader_usd,suggest_usd,sell_pct,status,applied_tx,acted_at,created_at&order=id.desc&limit=60`
      )) || [];
    const ids = [...new Set(signals.map((s) => s.coin_id))];
    const coins = ids.length
      ? await sec(env, `coins?id=in.(${q(ids.map((i) => `"${i}"`).join(","))})&select=id,name,symbol,logo`)
      : [];
    return json({ signals, coins: coins || [] });
  }

  if (p[0] === "signal" && p.length === 1 && method === "POST") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, "Unknown signal.");
    const action = body.action === "apply" ? "applied" : body.action === "reject" ? "rejected" : null;
    if (!action) return fail(400, "Bad request.");
    const tx = typeof body.tx === "string" ? body.tx.toLowerCase() : null;
    if (action === "applied" && !/^0x[0-9a-f]{64}$/.test(tx || "")) return fail(400, "Missing the transaction.");
    const patch = { status: action, acted_at: new Date().toISOString() };
    if (action === "applied") patch.applied_tx = tx;
    const done = await sec(env, `copy_signals?id=eq.${id}&follower=eq.${q(me)}&status=eq.pending&select=id`, {
      method: "PATCH",
      body: patch,
      prefer: "return=representation",
    });
    if (!done || !done.length) return fail(409, "This signal was already handled or has expired.");
    return json({ ok: true });
  }

  return fail(404, "Not found.");
}
