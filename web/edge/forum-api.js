// Forum API: called from functions/api/[[path]].js once the session is checked.
//
//   GET    /api/forum/me?board=…&thread=…      what this wallet may do here
//   POST   /api/forum/threads                  { board, title, body }          → { url }
//   POST   /api/forum/threads/:id/posts        { body }                        → { url }
//   POST   /api/forum/threads/:id/pin          { pinned }                      (admins)
//   POST   /api/forum/posts/:id/like                                            → { likes, liked }
//   POST   /api/forum/posts/:id/report
//   POST   /api/forum/posts/:id/hide           { hidden }                      (coin creator, admins)
//   DELETE /api/forum/posts/:id                                                 (own posts)

import {
  COIN_ID,
  GENERAL,
  SITE,
  admins,
  coinById,
  holdingBps,
  q,
  sec,
  shortAddr,
  threadUrl,
  wordCount,
} from "./forum-core.js";

export const INDEXNOW_KEY = "ba976996d56d88909a85f1b971ae913a";

const LIMITS = { gapSeconds: 15, threadsPerDay: 5, postsPerDay: 60, links: 3 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);

function clean(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
const cleanTitle = (s) => clean(s).replace(/\s+/g, " ");
const linkCount = (s) => (s.match(/https?:\/\//gi) || []).length;
const shouting = (s) => {
  const letters = s.replace(/[^A-Za-z]/g, "");
  return letters.length > 12 && letters === letters.toUpperCase();
};

async function boardInfo(env, board) {
  if (board === GENERAL) return { board, coin: null };
  if (!COIN_ID.test(board)) return null;
  const coin = await coinById(env, board);
  return coin ? { board, coin } : null;
}

async function isMod(env, me, info) {
  if (admins(env).includes(me)) return true;
  return !!(info.coin && info.coin.creator === me);
}

/** Can this wallet post on this board? Returns { ok, reason, share }. */
async function postingRight(env, me, info) {
  if (!info.coin) return { ok: true, share: 0 };
  const share = await holdingBps(env, info.coin.id, me);
  if (share > 0 || info.coin.creator === me || admins(env).includes(me)) return { ok: true, share };
  return { ok: false, reason: "hold", share: 0 };
}

async function rateCheck(env, me, isThread) {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const [last, today, threadsToday] = await Promise.all([
    sec(env, `forum_posts?author=eq.${q(me)}&select=created_at&order=created_at.desc&limit=1`),
    sec(env, `forum_posts?author=eq.${q(me)}&created_at=gt.${q(since)}&select=id&limit=${LIMITS.postsPerDay}`),
    isThread ? sec(env, `forum_threads?author=eq.${q(me)}&created_at=gt.${q(since)}&select=id&limit=${LIMITS.threadsPerDay}`) : [],
  ]);
  if (last.length && Date.now() - Date.parse(last[0].created_at) < LIMITS.gapSeconds * 1000) return "Wait a few seconds before posting again.";
  if (today.length >= LIMITS.postsPerDay) return "You've reached today's post limit. Try again tomorrow.";
  if (isThread && threadsToday.length >= LIMITS.threadsPerDay) return "You can start 5 threads a day. Try again tomorrow.";
  return null;
}

function pingIndexNow(ctx, urls) {
  const body = JSON.stringify({ host: "sasapad.fun", key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls });
  const send = fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

async function threadWithBoard(env, id) {
  const rows = await sec(env, `forum_threads?id=eq.${id}&select=id,board,title,author,hidden,pinned`);
  const t = rows && rows[0];
  if (!t || t.hidden) return null;
  const info = await boardInfo(env, t.board);
  return info ? { t, info } : null;
}

// ------------------------------------------------------------------ routes

export async function forumRoute(ctx, me, parts, method, body, url) {
  const env = ctx.env;
  const p = parts.slice(1); // after "forum"

  if (p[0] === "me" && p.length === 1 && method === "GET") {
    const board = url.searchParams.get("board") || "";
    const info = await boardInfo(env, board);
    if (!info) return fail(404, "Unknown board.");
    const right = await postingRight(env, me, info);
    const threadId = Number(url.searchParams.get("thread") || 0);
    let likes = [];
    if (threadId > 0) {
      const posts = await sec(env, `forum_posts?thread_id=eq.${threadId}&select=id&limit=500`);
      const ids = (posts || []).map((x) => x.id);
      if (ids.length) {
        const l = await sec(env, `forum_likes?owner=eq.${q(me)}&post_id=in.(${ids.join(",")})&select=post_id`);
        likes = (l || []).map((x) => Number(x.post_id));
      }
    }
    return json({
      address: me,
      canPost: right.ok,
      reason: right.reason || null,
      share: right.share,
      mod: await isMod(env, me, info),
      admin: admins(env).includes(me),
      likes,
    });
  }

  if (p[0] === "threads" && p.length === 1 && method === "POST") {
    const board = typeof body.board === "string" ? body.board.toLowerCase() : "";
    const info = await boardInfo(env, board);
    if (!info) return fail(404, "Unknown board.");
    const title = cleanTitle(body.title);
    const text = clean(body.body);
    if (title.length < 8) return fail(400, "Make the title a little longer (8+ characters).");
    if (title.length > 120) return fail(400, "Keep the title under 120 characters.");
    if (shouting(title)) return fail(400, "Please don't write the title in capitals.");
    if (text.length < 20) return fail(400, "Write a bit more (20+ characters) so the thread is useful.");
    if (text.length > 4000) return fail(400, "Keep the post under 4000 characters.");
    if (linkCount(title) > 0) return fail(400, "Links go in the post, not the title.");
    if (linkCount(text) > LIMITS.links) return fail(400, `At most ${LIMITS.links} links per post.`);
    const right = await postingRight(env, me, info);
    if (!right.ok) return fail(403, `Only $${info.coin.symbol} holders can post here.`);
    const slow = await rateCheck(env, me, true);
    if (slow) return fail(429, slow);

    const words = wordCount(title) + wordCount(text);
    const [t] = await sec(env, "forum_threads?select=id,title", {
      method: "POST",
      body: { board, title, author: me, words },
      prefer: "return=representation",
    });
    try {
      await sec(env, "forum_posts", { method: "POST", body: { thread_id: t.id, author: me, body: text, share_bps: right.share } });
    } catch (e) {
      await sec(env, `forum_threads?id=eq.${t.id}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
    const path = threadUrl(info.coin || GENERAL, t);
    pingIndexNow(ctx, [`${SITE}${path}`]);
    return json({ url: path }, 201);
  }

  if (p[0] === "threads" && /^\d{1,15}$/.test(p[1] || "") && p[2] === "posts" && p.length === 3 && method === "POST") {
    const found = await threadWithBoard(env, p[1]);
    if (!found) return fail(404, "This thread is gone.");
    const { t, info } = found;
    const text = clean(body.body);
    if (text.length < 2) return fail(400, "Write a reply first.");
    if (text.length > 4000) return fail(400, "Keep the reply under 4000 characters.");
    if (linkCount(text) > LIMITS.links) return fail(400, `At most ${LIMITS.links} links per post.`);
    const right = await postingRight(env, me, info);
    if (!right.ok) return fail(403, `Only $${info.coin.symbol} holders can reply here.`);
    const slow = await rateCheck(env, me, false);
    if (slow) return fail(429, slow);

    const [post] = await sec(env, "forum_posts?select=id", {
      method: "POST",
      body: { thread_id: t.id, author: me, body: text, share_bps: right.share },
      prefer: "return=representation",
    });
    await sec(env, "rpc/forum_after_post", { method: "POST", body: { p_thread: t.id, p_words: wordCount(text) } });
    const path = threadUrl(info.coin || GENERAL, t);

    // Tell the thread's author (🔔 on the site; the indexer sends it to their phone).
    if (t.author !== me) {
      const excerpt = text.replace(/\s+/g, " ").slice(0, 140) + (text.length > 140 ? "…" : "");
      await sec(env, "notifications", {
        method: "POST",
        body: {
          owner: t.author,
          coin_id: info.coin ? info.coin.id : null,
          kind: "forum",
          title: `${shortAddr(me)} replied to “${t.title.slice(0, 80)}”`,
          body: excerpt,
          url: `${SITE}${path}#p${post.id}`,
          pushed: false,
        },
      }).catch(() => {});
    }
    pingIndexNow(ctx, [`${SITE}${path}`]);
    return json({ url: `${path}#p${post.id}`, id: post.id }, 201);
  }

  if (p[0] === "threads" && /^\d{1,15}$/.test(p[1] || "") && p[2] === "pin" && p.length === 3 && method === "POST") {
    if (!admins(env).includes(me)) return fail(403, "Only sasa admins can pin threads.");
    await sec(env, `forum_threads?id=eq.${p[1]}`, { method: "PATCH", body: { pinned: !!body.pinned } });
    return json({ ok: true });
  }

  if (p[0] === "posts" && /^\d{1,15}$/.test(p[1] || "")) {
    const rows = await sec(env, `forum_posts?id=eq.${p[1]}&select=id,thread_id,author,hidden`);
    const post = rows && rows[0];
    if (!post) return fail(404, "This post is gone.");
    const found = await threadWithBoard(env, post.thread_id);
    if (!found) return fail(404, "This thread is gone.");
    const first = await sec(env, `forum_posts?thread_id=eq.${post.thread_id}&select=id&order=id.asc&limit=1`);
    const isFirst = first && first[0] && Number(first[0].id) === Number(post.id);

    if (p[2] === "like" && p.length === 3 && method === "POST") {
      if (post.hidden) return fail(400, "This post is hidden.");
      const likes = await sec(env, "rpc/forum_toggle_like", { method: "POST", body: { p_post: Number(post.id), p_owner: me } });
      const mine = await sec(env, `forum_likes?post_id=eq.${post.id}&owner=eq.${q(me)}&select=post_id`);
      return json({ likes: Number(likes), liked: !!(mine && mine.length) });
    }
    if (p[2] === "report" && p.length === 3 && method === "POST") {
      if (post.author === me) return fail(400, "You can't report your own post.");
      await sec(env, "rpc/forum_report", { method: "POST", body: { p_post: Number(post.id), p_owner: me } });
      return json({ ok: true });
    }
    if (p[2] === "hide" && p.length === 3 && method === "POST") {
      if (!(await isMod(env, me, found.info))) return fail(403, "Only the coin's creator or sasa admins can hide posts.");
      const hide = body.hidden !== false;
      await sec(env, `forum_posts?id=eq.${post.id}`, { method: "PATCH", body: { hidden: hide ? "mod" : null, ...(hide ? {} : { report_count: 0 }) } });
      if (!hide) await sec(env, `forum_reports?post_id=eq.${post.id}`, { method: "DELETE" });
      if (isFirst) await sec(env, `forum_threads?id=eq.${post.thread_id}`, { method: "PATCH", body: { hidden: hide } });
      else await sec(env, "rpc/forum_after_post", { method: "POST", body: { p_thread: Number(post.thread_id), p_words: 0, p_bump: false } });
      return json({ ok: true, threadHidden: isFirst && hide });
    }
    if (p.length === 2 && method === "DELETE") {
      if (post.author !== me) return fail(403, "You can only delete your own posts.");
      await sec(env, `forum_posts?id=eq.${post.id}`, { method: "PATCH", body: { hidden: "self" } });
      if (isFirst) await sec(env, `forum_threads?id=eq.${post.thread_id}`, { method: "PATCH", body: { hidden: true } });
      else await sec(env, "rpc/forum_after_post", { method: "POST", body: { p_thread: Number(post.thread_id), p_words: 0, p_bump: false } });
      return json({ ok: true, threadHidden: isFirst });
    }
  }

  return fail(404, "Not found.");
}
