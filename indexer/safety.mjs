// Beta safety locks: copies each chain's pause switch and capacity from its
// live factory into chain_safety (the site reads it from there), and tells
// the admins with a 🔔 notification (and web push) when a chain is paused,
// resumed, or its capacity passes 80% / fills up.
//
// Env:
//   ADMINS            comma-separated admin wallet addresses to notify
//   SAFETY_EVERY_MS   how often to read the chains (default 10000)
//   SITE_URL          for the notification link (default https://sasapad.fun)

import { parseAbi } from "viem";

const abi = parseAbi([
  "function buysPaused() view returns (bool)",
  "function nativeCap() view returns (uint256)",
  "function totalNative() view returns (uint256)",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param chains [{ name, chainId, pub, factory }] factory = the live factory */
export async function safetyLoop(pool, chains, log) {
  const every = Number(process.env.SAFETY_EVERY_MS ?? "10000");
  const site = (process.env.SITE_URL ?? "https://sasapad.fun").replace(/\/$/, "");
  const admins = (process.env.ADMINS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (!admins.length) log("safety: set ADMINS to get 🔔 alerts about pauses and capacity");

  // What we last told the admins, per chain: paused? and capacity level (0, 80, 100).
  const told = new Map();
  let tableWarned = false;

  const notify = async (title, body) => {
    if (!admins.length) return;
    await pool.query(
      `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
       select a, null, 'safety', $2, $3, $4, false from unnest($1::text[]) a`,
      [admins, title, body, `${site}/admin/`]
    );
  };

  for (;;) {
    for (const c of chains) {
      try {
        const r = (functionName) => c.pub.readContract({ address: c.factory, abi, functionName });
        const [paused, cap, total, guardian, owner] = await Promise.all([
          r("buysPaused"),
          r("nativeCap"),
          r("totalNative"),
          r("guardian"),
          r("owner"),
        ]);
        await pool.query(
          `insert into chain_safety (chain_id, factory, paused, cap, total, guardian, owner, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (chain_id) do update set factory = $2, paused = $3, cap = $4, total = $5,
             guardian = $6, owner = $7, updated_at = now()`,
          [c.chainId, c.factory.toLowerCase(), paused, cap.toString(), total.toString(), guardian.toLowerCase(), owner.toLowerCase()]
        );
        tableWarned = false;

        const pct = cap > 0n ? Number((total * 1000n) / cap) / 10 : 0;
        const level = cap > 0n ? (pct >= 100 ? 100 : pct >= 80 ? 80 : pct < 70 ? 0 : null) : 0;
        const was = told.get(c.chainId);
        if (!was) {
          // First look after a restart: remember, don't alert about the old state.
          told.set(c.chainId, { paused, level: level ?? 0 });
          continue;
        }
        if (paused !== was.paused) {
          await notify(
            paused ? `⏸ Buys paused on ${c.name}` : `▶ Buys resumed on ${c.name}`,
            paused ? "Launches and buys are stopped. Selling still works." : "Launches and buys are open again."
          );
          was.paused = paused;
        }
        // level null = between 70% and 80%: keep the last level so it doesn't flap.
        if (level !== null && level !== was.level) {
          if (level > was.level) {
            await notify(
              level === 100 ? `🛑 ${c.name} is at full capacity` : `⚠ ${c.name} is ${Math.round(pct)}% full`,
              level === 100
                ? "New buys and launches there are refused. Raise the cap from the admin page."
                : "Raise the cap from the admin page before it fills."
            );
          }
          was.level = level;
        }
      } catch (e) {
        if (/relation "chain_safety" does not exist/.test(e.message)) {
          if (!tableWarned) log("safety: run indexer/safety.sql in Supabase");
          tableWarned = true;
        } else if (!/buysPaused|returned no data|reverted/i.test(e.message)) {
          log(`safety ${c.name}: ${e.shortMessage ?? e.message}`);
        }
      }
    }
    await sleep(every);
  }
}
