// AI launch helper (update-39), on Cloudflare Workers AI (binding named "AI").
//
//   POST /api/ai/ideas  { idea }    → { ideas: [{ name, symbol, description, art }] }
//   POST /api/ai/logo   { art }     → { image: "data:image/jpeg;base64,…" }
//   POST /api/ai/coin   { idea }    → { name, symbol, description, image | null }
//   POST /api/ai/reply  { url }     → { author, text, tweetId, replies: [3] }   admins only: reply ideas
//        for a post on X, which the admin sends himself (X intent link)
//        one coin in one go (the race launch page): one idea, one picture
//
// Signed-in users only, with a daily allowance per account (ai.sql). If the
// binding isn't set up, or the free daily quota is used up, it answers with a
// friendly message and the normal launch form keeps working.

import { sec } from "./forum-core.js";

// Tried in order: Cloudflare retires models now and then (llama-3.1-8b went
// on 2026-05-30), so one going away doesn't break the feature.
const TEXT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/google/gemma-4-26b-a4b-it",
];
// Tried in order. flux answers { image: base64 JPEG }; the others answer raw PNG bytes.
const IMAGE_MODELS = [
  ["@cf/black-forest-labs/flux-1-schnell", (prompt) => ({ prompt, steps: 4 })],
  ["@cf/bytedance/stable-diffusion-xl-lightning", (prompt) => ({ prompt, num_steps: 4, width: 512, height: 512 })],
  ["@cf/lykon/dreamshaper-8-lcm", (prompt) => ({ prompt, num_steps: 8, width: 512, height: 512 })],
];

/** The picture as a data URL, whatever shape the model returned. */
async function imageOf(out) {
  if (!out) return null;
  if (typeof out.image === "string" && out.image.length > 100) return `data:image/jpeg;base64,${out.image}`;
  let bytes = null;
  if (out instanceof Uint8Array) bytes = out;
  else if (out instanceof ArrayBuffer) bytes = new Uint8Array(out);
  else if (typeof out.getReader === "function") bytes = new Uint8Array(await new Response(out).arrayBuffer());
  if (!bytes || bytes.length < 100) return null;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return `data:image/${jpeg ? "jpeg" : "png"};base64,${btoa(bin)}`;
}

/** The generated text, whatever envelope the model uses. */
function textOf(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return JSON.stringify(out.response);
  const c = out.choices && out.choices[0];
  if (c && c.message && typeof c.message.content === "string") return c.message.content;
  if (c && typeof c.text === "string") return c.text;
  if (typeof out.output_text === "string") return out.output_text;
  if (Array.isArray(out.output)) {
    for (const o of out.output) {
      for (const p of (o && o.content) || []) if (p && typeof p.text === "string") return p.text;
    }
  }
  return "";
}

// Admins (FORUM_ADMINS) see the model's own error, to fix things fast.
let adminView = false;
const adminMsg = (e) => `Admin view: ${String((e && (e.message || e)) || "no error message").slice(0, 160)}`;

const codeOf = (e) => {
  const m = /\b(\d{4})\b/.exec(String((e && e.message) || ""));
  return m ? ` (code ${m[1]})` : "";
};
const IDEAS_PER_DAY = 10;
const LOGOS_PER_DAY = 40;
const COINS_PER_DAY = 10;
// New wallets are free to make, so the allowance is also counted per network address (3 accounts'
// worth) and for everyone together, so no one can use up the whole day's AI for the site.
const PER_IP = 3;
const EVERYONE_PER_DAY = { ideas: 400, coin: 300, logo: 600 };

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);

// Words we won't put on a coin, and names we won't imitate.
const BLOCK = /\b(nazi|hitler|isis|rape|child|kid|porn|sex|nsfw|terror|kill|suicide|nigg|fag|retard|jew|muslim|christian)\w*/i;
const BRANDS = /\b(bitcoin|btc|ethereum|eth|solana|sol|binance|bnb|coinbase|robinhood|tether|usdt|usdc|trump|musk|elon|pepe|doge|shib|disney|nike|apple|google|tesla|pokemon|mario)\b/i;

async function take(env, me, kind, limit) {
  try {
    const ok = await sec(env, "rpc/ai_take", { method: "POST", body: { p_address: me, p_kind: kind, p_limit: limit } });
    return ok === true;
  } catch (e) {
    // Table not set up yet: allow, but only while the rest works.
    if (/ai_take|does not exist|schema cache/i.test(e.message || "")) return true;
    throw e;
  }
}

/** An IPv6 address's /64 network, written out in full ("2001:db8::1" → "2001:0db8:0000:0000::/64"). */
export function net64(ip) {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const all = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return all.slice(0, 4).map((g) => g.padStart(4, "0").toLowerCase()).join(":") + "::/64";
}

/** null when this use is allowed (and counted); otherwise who ran out: "you", "network" or "everyone". */
async function allowance(ctx, me, kind, perAccount) {
  const env = ctx.env;
  if (!(await take(env, me, kind, perAccount))) return "you";
  // IPv6: one home or server gets a whole /64, so the first four groups count as one network
  let ip = String(ctx.request.headers.get("cf-connecting-ip") || "").slice(0, 64);
  if (ip.includes(":")) ip = net64(ip);
  if (ip && !(await take(env, `ip:${ip}`, kind, perAccount * PER_IP))) return "network";
  if (!(await take(env, "everyone", kind, EVERYONE_PER_DAY[kind]))) return "everyone";
  return null;
}
const usedUp = (who, mine) =>
  fail(429, who === "you" ? mine : who === "network" ? "That's all the AI for this network today. Fill in the form below instead." : "The AI helper is busy for today. Fill in the form below instead.");

function clean(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Pulls the first JSON array (or {ideas:[…]}) out of whatever the model said. */
function parseIdeas(out) {
  let v = out;
  if (v && typeof v === "object" && "response" in v) v = v.response;
  if (typeof v === "string") {
    const s = v.replace(/```(?:json)?/gi, "");
    const a = s.indexOf("[");
    const b = s.lastIndexOf("]");
    const o = s.indexOf("{");
    try {
      v = a >= 0 && b > a && (o < 0 || a < o) ? JSON.parse(s.slice(a, b + 1)) : JSON.parse(s.slice(o, s.lastIndexOf("}") + 1));
    } catch {
      return [];
    }
  }
  if (v && !Array.isArray(v) && Array.isArray(v.ideas)) v = v.ideas;
  return Array.isArray(v) ? v : [];
}

/** `count` coin ideas for one sentence: { list } or { error: Response }. */
async function makeIdeas(env, idea, count) {
  const system =
    `You name meme coins. Reply with ONLY a JSON array of exactly ${count} object${count === 1 ? "" : "s"}, no other text. ` +
    'Each object: {"name": catchy coin name, 2-4 words, max 28 characters; ' +
    '"symbol": ticker, 3-6 capital letters A-Z only; ' +
    '"description": one fun sentence, max 140 characters, no promises of profit, no emojis; ' +
    '"art": a short visual description of a cute mascot logo for this coin, max 25 words}. ' +
    (count > 1 ? `Make the ${count} ideas clearly different. ` : "") +
    "Never use real people, brands, celebrities, existing crypto names, " +
    "or anything hateful, sexual or violent.";
  let out = null;
  let lastErr = null;
  for (const model of TEXT_MODELS) {
    try {
      const res = await env.AI.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Coin idea: ${idea}` },
        ],
        // Some newer models think before answering; leave them room.
        max_tokens: 1500,
        temperature: 0.9,
      });
      const text = textOf(res);
      if (parseIdeas(text).length) {
        out = text;
        break;
      }
      lastErr = new Error(`${model}: no ideas in the answer`);
    } catch (e) {
      lastErr = e;
      console.error("ai ideas", model, e && e.message);
    }
  }
  if (out === null) {
    console.error("ai ideas failed", lastErr && lastErr.message);
    return { error: fail(503, adminView ? adminMsg(lastErr) : `Our AI is busy right now. Try again in a minute, or fill in the form below.${codeOf(lastErr)}`) };
  }
  const seen = new Set();
  const ideas = parseIdeas(out)
    .map((x) => ({
      name: clean(x && x.name, 32),
      symbol: clean(x && x.symbol, 12).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8),
      description: clean(x && x.description, 200),
      art: clean(x && x.art, 240),
    }))
    .filter((x) => x.name.length >= 2 && x.symbol.length >= 2 && !BLOCK.test(x.name + " " + x.description) && !BRANDS.test(x.name + " " + x.symbol))
    .filter((x) => (seen.has(x.symbol) ? false : (seen.add(x.symbol), true)))
    .slice(0, count);
  if (!ideas.length) return { error: fail(502, "The AI came back empty. Try again, maybe with a different sentence.") };
  return { list: ideas };
}

/** One mascot picture: { image } or { image: null, message }. */
async function drawLogo(env, art) {
  const prompt =
    `Cute meme coin mascot logo: ${art}. Centered single character, bold simple shapes, vibrant colors, ` +
    "soft gradient background, flat vector illustration, sticker style, no text, no letters, no watermark.";
  let image = null;
  let lastErr = null;
  // A safety check sometimes trips on harmless words; a plainer prompt usually passes.
  const plain = `Cute cartoon mascot logo, ${art.split(/[,.]/)[0]}, flat vector, vibrant colors, no text`;
  outer: for (const [model, input] of IMAGE_MODELS) {
    for (const p of [prompt, plain]) {
      try {
        image = await imageOf(await env.AI.run(model, input(p)));
        if (image) break outer;
        lastErr = new Error(`${model}: empty picture`);
      } catch (e) {
        lastErr = e;
        console.error("ai logo", model, e && e.message);
      }
    }
  }
  if (!image) return { image: null, message: adminView ? adminMsg(lastErr) : `Couldn't draw a picture right now. Try again, or upload your own.${codeOf(lastErr)}` };
  return { image };
}

/** A public post on X: { author, text, id } through X's free oEmbed (no API key). */
export async function readTweet(url) {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/.exec(String(url || "").trim());
  if (!m) return null;
  const link = `https://twitter.com/${m[1]}/status/${m[2]}`;
  const r = await fetch(`https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(link)}`);
  if (!r.ok) return { author: m[1], text: "", id: m[2] };
  const j = await r.json();
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(j.html || "");
  const text = (p ? p[1] : "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/pic\.twitter\.com\/\S+/g, "")
    .trim();
  return { author: j.author_name || m[1], handle: m[1], text, id: m[2] };
}

const REPLY_STYLE =
  "You write replies on X (Twitter) for a crypto trader account. Write exactly 3 different replies to the post. " +
  "Rules: each under 200 characters; lowercase, casual, slightly loose like a real person typing fast; " +
  "smart and specific to the post (point out a detail, a number, a contrarian angle, or ask a sharp question) so people reply or follow; " +
  "at most one emoji, often none; no hashtags; no links; never mention any website, product or brand; " +
  "no slogans, no 'great post', no flattery, no financial advice, nothing rude. " +
  'Reply with ONLY a JSON array of 3 strings, no other text.';

export async function makeReplies(env, post, extra) {
  let lastErr = null;
  for (const model of TEXT_MODELS) {
    try {
      const res = await env.AI.run(model, {
        messages: [
          { role: "system", content: REPLY_STYLE },
          { role: "user", content: `Post by @${post.handle || post.author}:\n${post.text || "(no text, only an image)"}${extra ? `\n\nWhat the image shows / extra context: ${extra}` : ""}` },
        ],
        max_tokens: 1200,
        temperature: 0.95,
      });
      const list = parseIdeas(textOf(res))
        .map((x) => clean(typeof x === "string" ? x : x && (x.text || x.reply), 270).replace(/#\w+/g, "").replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim())
        .filter((x) => x.length >= 8)
        .slice(0, 3);
      if (list.length) return { list };
      lastErr = new Error(`${model}: no replies in the answer`);
    } catch (e) {
      lastErr = e;
    }
  }
  return { error: fail(503, adminView ? adminMsg(lastErr) : "The AI is busy. Try again in a minute.") };
}

export async function aiRoute(ctx, me, parts, method, body) {
  const env = ctx.env;
  adminView = String(env.FORUM_ADMINS || "")
    .toLowerCase()
    .split(",")
    .map((a) => a.trim())
    .includes(String(me).toLowerCase());
  if (method !== "POST" || parts.length !== 2) return fail(404, "Not found.");
  if (!env.AI || typeof env.AI.run !== "function") return fail(503, "AI ideas aren't switched on yet. Fill in the form below instead.");

  if (parts[1] === "reply") {
    // the admins, and the team's phone wallet (same list as the geo exemption in lib/perps.ts)
    const helpers = ["0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b", "0xe0ba5905940d748b23dc01266aa884e2391cca2f"];
    if (!adminView && !helpers.includes(String(me).toLowerCase())) return fail(403, "Admins only.");
    const post = await readTweet(body.url);
    if (!post) return fail(400, "Paste a link to a post on X (x.com/…/status/…).");
    const extra = clean(body.extra, 400);
    if (!post.text && !extra) return fail(400, "Couldn't read that post's text. Write in a few words what it says below and try again.");
    const out = await makeReplies(env, post, extra);
    if (out.error) return out.error;
    return json({ author: post.author, handle: post.handle, text: post.text, tweetId: post.id, replies: out.list });
  }

  if (parts[1] === "ideas") {
    const idea = clean(body.idea, 200);
    if (idea.length < 3) return fail(400, "Write a few words about your coin first.");
    if (BLOCK.test(idea)) return fail(400, "Let's keep it friendly. Try another idea.");
    const no = await allowance(ctx, me, "ideas", IDEAS_PER_DAY);
    if (no) return usedUp(no, `That's your ${IDEAS_PER_DAY} AI ideas for today. Come back tomorrow, or fill in the form below.`);

    const ideas = await makeIdeas(env, idea, 3);
    if (ideas.error) return ideas.error;
    return json({ ideas: ideas.list });
  }

  if (parts[1] === "coin") {
    const idea = clean(body.idea, 200);
    if (idea.length < 3) return fail(400, "Write a few words about your coin first.");
    if (BLOCK.test(idea)) return fail(400, "Let's keep it friendly. Try another idea.");
    const no = await allowance(ctx, me, "coin", COINS_PER_DAY);
    if (no) return usedUp(no, `That's your ${COINS_PER_DAY} AI coins for today. Come back tomorrow, or fill in the form yourself.`);
    const ideas = await makeIdeas(env, idea, 1);
    if (ideas.error) return ideas.error;
    const pick = ideas.list[0];
    const drawn = await drawLogo(env, pick.art);
    // the name, ticker and story are still useful when the picture fails: the user can upload one
    return json({ name: pick.name, symbol: pick.symbol, description: pick.description, image: drawn.image, imageError: drawn.image ? null : drawn.message });
  }

  if (parts[1] === "logo") {
    const art = clean(body.art, 240);
    if (art.length < 3 || BLOCK.test(art)) return fail(400, "Can't draw that one.");
    const no = await allowance(ctx, me, "logo", LOGOS_PER_DAY);
    if (no) return usedUp(no, "That's all the AI pictures for today. Upload your own below.");
    const drawn = await drawLogo(env, art);
    if (!drawn.image) return fail(503, drawn.message);
    const image = drawn.image;
    return json({ image });
  }

  return fail(404, "Not found.");
}
