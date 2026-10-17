// Watchdog: tells sasa's admin (the 🔔 on the site, for the admin wallet only, pushed to the
// phone like every notification) when a Railway service stops reporting, and when it's back.
//
// Every service writes a heartbeat (service_heartbeats): the race keeper each pass, the auto-order
// keeper and the rewards service each minute, this indexer each minute. A service that reported
// before and has been quiet for WATCHDOG_MINUTES (default 15) is down. One note when it goes
// quiet, one when it's back; never a stream.
//
// Env: ADMINS (admin wallets, comma-separated; default sasa admin), SITE_URL, WATCHDOG_MINUTES

const DEFAULT_ADMIN = "0xe0ba5905940d748b23dc01266aa884e2391cca2f";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function watchdogOnce(pool, { admins, minutes, site, down, now = Date.now() }) {
  await pool.query(
    `insert into service_heartbeats (service, at, info) values ('indexer', now(), '')
     on conflict (service) do update set at = now()`
  );
  const { rows } = await pool.query("select service, at from service_heartbeats where service <> 'indexer'");
  const notes = [];
  for (const r of rows) {
    const quiet = now - new Date(r.at).getTime() >= minutes * 60_000;
    if (quiet && !down.has(r.service)) {
      down.add(r.service);
      notes.push([`⚠️ ${r.service} is down`, `${r.service} hasn't reported for ${minutes}+ minutes. Check it on Railway (logs, restart).`]);
    } else if (!quiet && down.has(r.service)) {
      down.delete(r.service);
      notes.push([`✅ ${r.service} is back`, `${r.service} is reporting again.`]);
    }
  }
  for (const [title, body] of notes) {
    await pool.query(
      `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
       select a, null, 'system', $2, $3, $4, false from unnest($1::text[]) a`,
      [admins, title, body, `${site}/admin/`]
    );
  }
  return notes;
}

export async function watchdogLoop(pool, log) {
  const admins = (process.env.ADMINS || DEFAULT_ADMIN)
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const minutes = Number(process.env.WATCHDOG_MINUTES ?? "15");
  const site = (process.env.SITE_URL ?? "https://sasapad.fun").replace(/\/$/, "");
  const down = new Set();
  let warned = false;
  for (;;) {
    try {
      const notes = await watchdogOnce(pool, { admins, minutes, site, down });
      for (const [t] of notes) log(`watchdog: ${t}`);
      warned = false;
    } catch (e) {
      if (!warned) log(/service_heartbeats/.test(e.message) ? "watchdog: run indexer/watchdog.sql in Supabase" : `watchdog: ${e.message}`);
      warned = true;
    }
    await sleep(60_000);
  }
}
