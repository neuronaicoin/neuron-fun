// AI launch helper (update-39), on Cloudflare Workers AI (binding named "AI").
//
//   POST /api/ai/ideas  { idea }    → { ideas: [{ name, symbol, description, art }] }
//   POST /api/ai/logo   { art }     → { image: "data:image/jpeg;base64,…" }
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
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

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

export async function aiRoute(ctx, me, parts, method, body) {
  const env = ctx.env;
  adminView = String(env.FORUM_ADMINS || "")
    .toLowerCase()
    .split(",")
    .map((a) => a.trim())
    .includes(String(me).toLowerCase());
  if (method !== "POST" || parts.length !== 2) return fail(404, "Not found.");
  if (!env.AI || typeof env.AI.run !== "function") return fail(503, "AI ideas aren't switched on yet. Fill in the form below instead.");

  if (parts[1] === "ideas") {
    const idea = clean(body.idea, 200);
    if (idea.length < 3) return fail(400, "Write a few words about your coin first.");
    if (BLOCK.test(idea)) return fail(400, "Let's keep it friendly. Try another idea.");
    if (!(await take(env, me, "ideas", IDEAS_PER_DAY))) return fail(429, `That's your ${IDEAS_PER_DAY} AI ideas for today. Come back tomorrow, or fill in the form below.`);

    const system =
      "You name meme coins. Reply with ONLY a JSON array of exactly 3 objects, no other text. " +
      'Each object: {"name": catchy coin name, 2-4 words, max 28 characters; ' +
      '"symbol": ticker, 3-6 capital letters A-Z only; ' +
      '"description": one fun sentence, max 140 characters, no promises of profit, no emojis; ' +
      '"art": a short visual description of a cute mascot logo for this coin, max 25 words}. ' +
      "Make the 3 ideas clearly different. Never use real people, brands, celebrities, existing crypto names, " +
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
      return fail(503, adminView ? adminMsg(lastErr) : `Our AI is busy right now. Try again in a minute, or fill in the form below.${codeOf(lastErr)}`);
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
      .slice(0, 3);
    if (!ideas.length) return fail(502, "The AI came back empty. Try again, maybe with a different sentence.");
    return json({ ideas });
  }

  if (parts[1] === "logo") {
    const art = clean(body.art, 240);
    if (art.length < 3 || BLOCK.test(art)) return fail(400, "Can't draw that one.");
    if (!(await take(env, me, "logo", LOGOS_PER_DAY))) return fail(429, "That's all the AI pictures for today. Upload your own below.");
    const prompt =
      `Cute meme coin mascot logo: ${art}. Centered single character, bold simple shapes, vibrant colors, ` +
      "soft gradient background, flat vector illustration, sticker style, no text, no letters, no watermark.";
    let out = null;
    let lastErr = null;
    // The image model's safety check sometimes trips on harmless words; a plainer prompt usually passes.
    for (const p of [prompt, `Cute cartoon mascot logo, ${art.split(/[,.]/)[0]}, flat vector, vibrant colors, no text`]) {
      try {
        out = await env.AI.run(IMAGE_MODEL, { prompt: p, num_steps: 4 });
        if (out && typeof out.image === "string") break;
      } catch (e) {
        lastErr = e;
        console.error("ai logo", e && e.message);
      }
    }
    if (!out || typeof out.image !== "string")
      return fail(503, adminView ? adminMsg(lastErr) : `Couldn't draw a picture right now. Try again, or upload your own.${codeOf(lastErr)}`);
    const b64 = out && typeof out.image === "string" ? out.image : null;
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 200))) return fail(502, "Couldn't draw a picture right now. Try again.");
    return json({ image: `data:image/jpeg;base64,${b64}` });
  }

  return fail(404, "Not found.");
}
