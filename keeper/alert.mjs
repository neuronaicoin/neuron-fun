// Tells sasa's admin when something needs a human, three ways:
//   - the 🔔 on sasapad.fun, for the admin wallet only (ADMIN_ALERT_TO, default sasa admin
//     0xe0ba…CcA2F), with a phone notification if the admin turned them on; needs SUPABASE_URL and
//     SUPABASE_SERVICE_KEY
//   - Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
//   - email through Resend (RESEND_API_KEY + ALERT_EMAIL)
// The same alert is sent at most once per ALERT_EVERY_MIN minutes (default 60).
//
// heartbeat(service) records that a service is alive (service_heartbeats), at most once a minute;
// the indexer's watchdog tells the admin when one goes quiet, and staleServices() lets a service
// check the others.
const last = new Map();
const EVERY = Number(process.env.ALERT_EVERY_MIN ?? "60") * 60_000;
const ADMIN = (process.env.ADMIN_ALERT_TO || "0xe0ba5905940d748b23dc01266aa884e2391cca2f").toLowerCase();
const SITE = (process.env.SITE_URL || "https://sasapad.fun").replace(/\/$/, "");

function rest(path, { method = "GET", body, prefer } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  return fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function alert(service, key, text) {
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < EVERY) return;
  last.set(key, now);
  const msg = `⚠️ sasa ${service}: ${text}`;
  console.log(new Date().toISOString(), "ALERT", msg);
  const tasks = [];
  // the admin's own 🔔 (only that wallet sees it); the indexer pushes it to the admin's phone
  if (/^0x[0-9a-f]{40}$/.test(ADMIN)) {
    const r = rest("notifications", {
      method: "POST",
      prefer: "return=minimal",
      body: { owner: ADMIN, coin_id: null, kind: "system", title: `⚠️ sasa ${service}`, body: String(text).slice(0, 500), url: `${SITE}/admin/`, pushed: false },
    });
    if (r) tasks.push(r);
  }
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: msg }),
      })
    );
  }
  const rk = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL;
  if (rk && to) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rk}` },
        body: JSON.stringify({ from: process.env.ALERT_FROM ?? "sasa alerts <alerts@sasapad.fun>", to, subject: `sasa ${service} alert`, text: msg }),
      })
    );
  }
  await Promise.allSettled(tasks);
}

let beatAt = 0;
/** This service is alive (at most one write a minute). */
export async function heartbeat(service, info = "") {
  const now = Date.now();
  if (now - beatAt < 60_000) return;
  beatAt = now;
  const r = rest("service_heartbeats?on_conflict=service", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: { service, at: new Date(now).toISOString(), info: String(info).slice(0, 200) },
  });
  if (r) await r.catch(() => {});
}

/** Services among `names` that beat before but not in the last `minutes`. */
export async function staleServices(names, minutes = 15) {
  const r = rest(`service_heartbeats?select=service,at&service=in.(${names.map(encodeURIComponent).join(",")})`);
  if (!r) return [];
  const res = await r.catch(() => null);
  if (!res || !res.ok) return [];
  const rows = await res.json().catch(() => []);
  const seen = new Map(rows.map((x) => [x.service, Date.parse(x.at)]));
  // a service that never beat isn't running here at all: only ones that went quiet count
  return names.filter((n) => seen.has(n) && Date.now() - seen.get(n) >= minutes * 60_000);
}
