// Big futures WHALE moves → sasa's Telegram channel, with the same picture card as on X. Only the
// big ones, so the channel never turns into noise: a top trader (Data tab) opens, flips, adds to
// or closes a position worth TG_WHALE_MIN (default $500K) or more (whale_moves, from whales.mjs).
//
// Limits: at least TG_WHALE_GAP_MIN minutes between posts (default 15), at most TG_WHALE_PER_DAY a
// day (default 24), the same trader + coin at most once in 6 hours. Only moves from the last 20
// minutes (a restart never posts old ones). The biggest waiting move goes first.
//
// Env (Railway → indexer → Variables; the same bot as the coin posts):
//   TG_POST_TOKEN   the bot's token from @BotFather (the bot is an admin of the channel)
//   TG_POST_CHAT    where to post, default "@sasapadfun"
//   TG_WHALE_OFF=1  switch off

import * as card from "./xbotcards.mjs";
import * as say from "./xbottext.mjs";

const SITE = "https://sasapad.fun";
const EVERY_MS = 30_000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SQL = `
create table if not exists tg_whale_posts (
  move_id   bigint primary key,
  address   text not null,
  coin      text not null,
  posted_at timestamptz not null default now()
);
alter table tg_whale_posts enable row level security;
revoke all on tg_whale_posts from anon, authenticated;`;

/** The post's words: the X wording without its hashtags, WHALE in bold, and where to see it. */
export function tgText(m, w) {
  const v = say.whale(m, w);
  const raw = v[Math.floor(Math.random() * v.length)][1];
  const body = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .trim();
  const coin = String(m.coin).slice(String(m.coin).indexOf(":") + 1);
  const link = `${SITE}/futures/?c=${encodeURIComponent(m.coin)}`;
  return `${esc(body).replace(/WHALES?/g, "<b>$&</b>")}\n\n📈 ${esc(coin)} live chart + copy this WHALE 👇\n${link}`;
}

async function sendPhoto(token, chat, png, caption) {
  const form = new FormData();
  form.set("chat_id", chat);
  form.set("caption", caption);
  form.set("parse_mode", "HTML");
  form.set("photo", new Blob([png], { type: "image/png" }), "whale.png");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `HTTP ${r.status}`);
}

async function nextMove(pool, minUsd) {
  const { rows } = await pool.query(
    `select m.id, m.address, m.coin, m.kind, m.side, m.usd, m.px, m.lev, w.rank, w.name, w.pnl_month
     from whale_moves m join whales w on w.address = m.address and w.listed
     where m.t > now() - interval '20 minutes' and m.usd >= $1 and m.kind in ('open','flip','add','close')
       and not exists (select 1 from tg_whale_posts p where p.move_id = m.id)
       and not exists (select 1 from tg_whale_posts p where p.address = m.address and p.coin = m.coin and p.posted_at > now() - interval '6 hours')
     order by m.usd desc limit 1`,
    [minUsd]
  );
  const r = rows[0];
  return r ? { ...r, usd: num(r.usd), px: num(r.px), lev: num(r.lev), rank: num(r.rank) || null, pnl_month: num(r.pnl_month) } : null;
}

export async function tgWhaleLoop(pool, log) {
  const token = process.env.TG_POST_TOKEN;
  if (!token || process.env.TG_WHALE_OFF === "1") return;
  const chat = process.env.TG_POST_CHAT || "@sasapadfun";
  const minUsd = num(process.env.TG_WHALE_MIN) || 500_000;
  const gapMs = (num(process.env.TG_WHALE_GAP_MIN) || 15) * 60_000;
  const perDay = num(process.env.TG_WHALE_PER_DAY) || 24;
  await pool.query(SQL);
  log(`tg whales: posting moves of $${Math.round(minUsd / 1000)}K+ to ${chat}`);
  let fails = 0;
  for (;;) {
    try {
      const last = await pool.query(
        `select max(posted_at) as at, count(*) filter (where posted_at > now() - interval '24 hours') as day from tg_whale_posts`
      );
      const lastAt = last.rows[0].at ? new Date(last.rows[0].at).getTime() : 0;
      if (Date.now() - lastAt >= gapMs && num(last.rows[0].day) < perDay) {
        const m = await nextMove(pool, minUsd);
        if (m) {
          // claim it first: a failed send is never retried into a double post
          await pool.query(`insert into tg_whale_posts (move_id, address, coin) values ($1, $2, $3) on conflict do nothing`, [m.id, m.address, m.coin]);
          await sendPhoto(token, chat, card.whaleCard(m, m), tgText(m, m));
          log(`tg whales: posted ${m.kind} ${m.coin} $${Math.round(m.usd / 1000)}K`);
        }
      }
      fails = 0;
    } catch (e) {
      fails++;
      if (fails === 1 || fails % 20 === 0) log(`tg whales: ${e.message}`);
    }
    await sleep(EVERY_MS);
  }
}
