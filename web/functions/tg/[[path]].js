/**
 * "sasa reply" Telegram bot: share a post from X to the bot, it answers with 3 reply ideas, each
 * with a "Reply on X" button that opens X with the reply already written. The person presses
 * Reply themselves (X doesn't allow automated replies to other people's posts).
 *
 *   GET  /tg/setup   once, after TG_REPLY_TOKEN is set: points the bot at /tg/hook
 *   POST /tg/hook    Telegram's updates (checked with a secret made from the token)
 *
 * Env (Cloudflare Pages): TG_REPLY_TOKEN  the bot's token from @BotFather
 *                         TG_REPLY_USERS  optional: Telegram user ids allowed, comma separated (unset: anyone
 *                                         who finds the bot can use it; it only writes text, never posts)
 * Uses the Workers AI binding "AI" like /api/ai.
 */
import { makeReplies, readTweet } from "../../edge/ai-api.js";

const SITE = "https://sasapad.fun";

async function secretOf(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sasa-tg:${token}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TG_REPLY_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const ok = () => new Response("ok");

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!env.TG_REPLY_TOKEN) return new Response("Set TG_REPLY_TOKEN in Cloudflare first.", { status: 503 });

  if (path === "/tg/setup") {
    const r = await tg(env, "setWebhook", {
      url: `${SITE}/tg/hook`,
      secret_token: await secretOf(env.TG_REPLY_TOKEN),
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    await tg(env, "setMyCommands", { commands: [{ command: "start", description: "How to use" }] }).catch(() => {});
    return new Response(r && r.ok ? "Done. Open the bot in Telegram and send /start." : `Telegram said: ${JSON.stringify(r)}`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (path !== "/tg/hook" || request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== (await secretOf(env.TG_REPLY_TOKEN))) return new Response("no", { status: 403 });

  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.chat) return ok();
  const chat = msg.chat.id;
  const from = String((msg.from && msg.from.id) || "");
  const allowed = String(env.TG_REPLY_USERS || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (allowed.length && !allowed.includes(from)) {
    await tg(env, "sendMessage", { chat_id: chat, text: "This bot is private." });
    return ok();
  }

  const text = String(msg.text || msg.caption || "");
  const link = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d{5,25}\S*/.exec(text);
  if (!link) {
    await tg(env, "sendMessage", {
      chat_id: chat,
      text: `Share a post from X to me (Share → Telegram → this bot), or paste its link. I'll send 3 replies with a button each.\n\nYour Telegram id: ${from}`,
    });
    return ok();
  }

  // Telegram waits at most ~60 s for this answer; the AI usually takes a few seconds
  ctx.waitUntil(
    (async () => {
      await tg(env, "sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
      const post = await readTweet(link[0]).catch(() => null);
      if (!post) return tg(env, "sendMessage", { chat_id: chat, text: "Couldn't read that link." });
      // anything written next to the link: what the picture shows, or an angle to take
      const extra = text.replace(link[0], "").trim().slice(0, 400);
      if (!post.text && !extra) return tg(env, "sendMessage", { chat_id: chat, text: "That post is only a picture. Send the link again with a few words on what it shows." });
      const out = await makeReplies(env, post, extra);
      if (out.error) return tg(env, "sendMessage", { chat_id: chat, text: "The AI is busy. Send the link again in a minute." });
      for (const r of out.list) {
        await tg(env, "sendMessage", {
          chat_id: chat,
          text: r,
          reply_markup: { inline_keyboard: [[{ text: "Reply on X →", url: `https://x.com/intent/post?in_reply_to=${post.id}&text=${encodeURIComponent(r)}` }]] },
        });
      }
    })().catch(() => {})
  );
  return ok();
}
