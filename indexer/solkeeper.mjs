/**
 * Solana launches, after the launch (web/lib/sollaunch.ts makes the coins):
 *
 *  1. Tables: sol_coins (every coin launched from sasa) and sol_config (the lookup table address).
 *  2. Checks each new coin on chain before sasa lists it: the coin exists on the launch curve
 *     and its creator fees are split 50% sasa (SOLANA_TREASURY) / 50% the creator. A coin whose
 *     split is anything else is marked "bad" and never listed.
 *  3. Every 30 minutes, pays out each coin's creator fees to both sides (sasa and the creator).
 *     Paying out is open to anyone on chain; the keeper only pays the network fee (a fraction of
 *     a cent). Before every payout the split is checked again.
 *  4. Makes and keeps sasa's address lookup table (lets a whole launch fit in one transaction).
 *  5. sasa's own-fee launches (soldbc.mjs, admin test): makes sasa's config once, lists those
 *     coins once they're on chain, and claims sasa's part of their trading fees into the treasury.
 *
 * Env (Railway):
 *   SOLANA_TREASURY      sasa's Solana wallet that receives its half (public address)
 *   SOLANA_RPC_URL       Solana node (Helius / QuickNode …); without it, Solana's public node
 *   SOLANA_KEEPER_KEY    secret key of a small Solana wallet that pays the network fees of the
 *                        payouts and the lookup table (base58 as Phantom exports it, or [1,2,…]);
 *                        without it nothing is paid out (coins are still checked)
 *   SOL_MIN_PAYOUT       smallest payout in SOL (default 0.005)
 *   SOLKEEPER_OFF=1      switches all of this off
 */
import { createRequire } from "node:module";
import { checkDbc, claimDbc, dbcPool, dbcPriceSol, dbcSdk, ensureDbcConfig } from "./soldbc.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const SHARE = 5000;
const CHECK_MS = 8_000; // a new launch is listed within seconds
const FULL_CHECK_EVERY_MS = 6 * 3600_000;

const SQL = `create table if not exists sol_coins (
  mint         text        primary key,
  creator      text        not null,
  owner        text,
  name         text,
  symbol       text,
  image        text,
  uri          text,
  sig          text,
  status       text        not null default 'pending',
  locked       boolean,
  note         text,
  created_at   timestamptz not null default now(),
  checked_at   timestamptz,
  full_at      timestamptz,
  paid_at      timestamptz,
  paid_lamports numeric    not null default 0,
  payouts      int         not null default 0
);
create index if not exists sol_coins_status on sol_coins (status, checked_at);
create index if not exists sol_coins_creator on sol_coins (creator);
create index if not exists sol_coins_owner on sol_coins (owner);
alter table sol_coins enable row level security;
revoke all on sol_coins from anon, authenticated;
create table if not exists sol_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table sol_config enable row level security;
revoke all on sol_config from anon, authenticated;
alter table sol_coins add column if not exists price_usd double precision;
alter table sol_coins add column if not exists mcap_usd double precision;
alter table sol_coins add column if not exists curve_done boolean;
alter table sol_coins add column if not exists priced_at timestamptz;
-- pump: the standard launch curve (50/50 creator-fee split); dbc: sasa's own-fee launch (soldbc.mjs)
alter table sol_coins add column if not exists kind text not null default 'pump';
-- launches that failed in someone's browser, with the step and Solana's own words (/api/sol/error)
create table if not exists sol_launch_errors (
  id       bigserial   primary key,
  at       timestamptz not null default now(),
  owner    text,
  creator  text,
  mint     text,
  kind     text,
  step     text,
  error    text,
  ua       text
);
create index if not exists sol_launch_errors_at on sol_launch_errors (at desc);
alter table sol_launch_errors enable row level security;
revoke all on sol_launch_errors from anon, authenticated;
delete from sol_launch_errors where at < now() - interval '30 days';
notify pgrst, 'reload schema';`;

/**
 * sasa's own Solana coins for the site's lists and coin pages (public: name, picture, price),
 * with market data from solmarkets.mjs once DexScreener has the coin, and the keeper's own
 * price from the launch curve before that. Made by whichever loop starts second (it needs both
 * sol_coins and sol_ext_tokens).
 */
export async function ensureSasaSolView(pool) {
  await pool.query(`do $$ begin
    if to_regclass('public.sol_coins') is not null and to_regclass('public.sol_ext_tokens') is not null then
      execute $v$
        create or replace view sol_sasa_coins as
        select 'solana'::text as network, 792703809::bigint as chain_id, c.mint as address, t.pool,
               coalesce(t.dex, case when c.kind = 'dbc' then 'meteora' else 'pumpfun' end) as dex, coalesce(c.name, t.name) as name, coalesce(c.symbol, t.symbol) as symbol,
               coalesce(t.image, c.image) as image, coalesce(t.price_usd, c.price_usd) as price_usd, t.fdv_usd,
               coalesce(t.mcap_usd, c.mcap_usd) as mcap_usd, t.liq_usd, t.vol_24h, t.change_1h, t.change_24h,
               t.buys_24h, t.sells_24h, coalesce(t.pool_created, c.created_at) as pool_created, null::integer as trending_rank,
               coalesce(t.seen_at, c.created_at) as seen_at, t.gp_checked_at, t.gp_buy_tax, t.gp_sell_tax, t.gp_mintable,
               t.gp_top10, t.x_handle, c.created_at, c.owner
        from sol_coins c left join sol_ext_tokens t on t.address = c.mint
        where c.status = 'live'
      $v$;
      execute 'grant select on sol_sasa_coins to anon, authenticated';
    end if;
  end $$;
  notify pgrst, 'reload schema';`);
}

function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * The keeper's key, in whichever form a wallet exports it: base58 (Phantom, MetaMask), hex
 * (with or without 0x), or a [1,2,…] list; the full 64-byte key or its 32-byte seed.
 */
function keeperKeypair(web3, raw) {
  const t = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!t) return null;
  let bytes;
  if (t.startsWith("[")) bytes = Uint8Array.from(JSON.parse(t));
  else if (/^(0x)?[0-9a-fA-F]{64}$|^(0x)?[0-9a-fA-F]{128}$/.test(t)) bytes = Uint8Array.from(Buffer.from(t.replace(/^0x/, ""), "hex"));
  else bytes = b58decode(t);
  if (bytes.length === 32) return web3.Keypair.fromSeed(bytes);
  if (bytes.length === 64) return web3.Keypair.fromSecretKey(bytes);
  throw new Error("SOLANA_KEEPER_KEY isn't a Solana secret key (copy it again from the wallet)");
}

/** Sends a signed transaction and waits until it's confirmed (or its blockhash runs out). */
async function sendConfirmed(conn, tx, lastValidBlockHeight) {
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) throw new Error(`refused: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (i % 3 === 2) conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    if (i % 10 === 9 && (await conn.getBlockHeight("confirmed").catch(() => 0)) > lastValidBlockHeight) throw new Error("expired");
  }
  throw new Error("not confirmed");
}

async function sendIxs(S, ixs, alt = null, extra = []) {
  const { web3, conn, keeper } = S;
  const bh = await conn.getLatestBlockhash("confirmed");
  const msg = new web3.TransactionMessage({
    payerKey: keeper.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs],
  }).compileToV0Message(alt ? [alt] : []);
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([keeper, ...extra]);
  return sendConfirmed(conn, tx, bh.lastValidBlockHeight);
}

// ------------------------------------------------------------------ the split check

/**
 * "ok" when the coin's creator fees are split 50/50 between sasa and one other wallet (its
 * creator, taken from the chain, never from what the site was told). `missing`: the coin or its
 * split isn't on chain (yet); `final`: the split is set to something else for good.
 */
async function checkSplit(S, row) {
  const { web3, pump, conn, treasury } = S;
  const mint = new web3.PublicKey(row.mint);
  const pda = pump.feeSharingConfigPda(mint);
  const [curveInfo, splitInfo] = await conn.getMultipleAccountsInfo([pump.bondingCurvePda(mint), pda], "confirmed");
  if (!curveInfo) return { ok: false, why: "no coin", missing: true };
  if (!splitInfo) return { ok: false, why: "no fee split", missing: true };
  const curve = pump.PUMP_SDK.decodeBondingCurve(curveInfo);
  if (!curve.creator.equals(pda)) return { ok: false, why: "fees not shared" };
  const split = pump.PUMP_SDK.decodeSharingConfig(splitInfo);
  const holders = split.shareholders;
  const ours = holders.find((h) => h.address.equals(treasury));
  const theirs = holders.find((h) => !h.address.equals(treasury));
  if (holders.length !== 2 || !ours || !theirs || ours.shareBps !== SHARE || theirs.shareBps !== 10_000 - SHARE)
    return { ok: false, why: "split is not 50/50", final: holders.length !== 1 };
  return { ok: true, creator: theirs.address.toBase58(), locked: !pump.isSharingConfigEditable({ sharingConfig: split }) };
}

/** A coin's name and symbol from its Token-2022 metadata (null when it has none). */
async function chainMeta(S, mint) {
  const r = await S.conn.getParsedAccountInfo(new S.web3.PublicKey(mint), "confirmed");
  const ext = r?.value?.data?.parsed?.info?.extensions ?? [];
  const m = ext.find((e) => e?.extension === "tokenMetadata")?.state;
  if (!m || typeof m.name !== "string") return null;
  const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) || null;
  return { name: clean(m.name, 32), symbol: clean(m.symbol, 10) };
}

async function checkNew(pool, S, log) {
  const { rows } = await pool.query(
    `select mint, creator, created_at, kind from sol_coins
     where status = 'pending' and (checked_at is null or checked_at < now() - interval '15 seconds')
     order by created_at desc limit 50`
  );
  for (const r of rows) {
    try {
      // sasa's own-fee coins: on chain under sasa's config is all there is to check
      const c = r.kind === "dbc" ? (S.dbcConfig ? await checkDbc(S, r) : null) : await checkSplit(S, r);
      // the keeper hasn't loaded sasa's own-fee config yet: the coin waits (never counted as missing)
      if (!c) {
        await pool.query(`update sol_coins set note = 'waiting for the own-fee config', checked_at = now() where mint = $1`, [r.mint]);
        continue;
      }
      // listed only once the 50/50 split can't be changed any more (until then it stays pending)
      if (c.ok && !c.locked) {
        await pool.query(`update sol_coins set note = 'split not locked yet', checked_at = now() where mint = $1`, [r.mint]);
        continue;
      }
      if (c.ok) {
        // the name and symbol shown are the coin's own (from its on-chain metadata), never only
        // what the launch page sent
        const meta = await chainMeta(S, r.mint).catch(() => null);
        await pool.query(
          `update sol_coins set status = 'live', creator = $3, locked = $2, note = null, checked_at = now(),
             name = coalesce($4, name), symbol = coalesce($5, symbol) where mint = $1`,
          [r.mint, c.locked, c.creator, meta?.name ?? null, meta?.symbol ?? null]
        );
        log(`sol: ${r.mint} is live (split ${c.locked ? "locked" : "set"})`);
      } else {
        // recorded just before signing: a coin that never showed up was not launched; a launch
        // that stopped half-way can still be finished for 2 days; a split set otherwise is bad
        const age = Date.now() - new Date(r.created_at).getTime();
        const status = c.final || (c.missing && age > 15 * 60_000) || age > 2 * 86400_000 ? "bad" : "pending";
        await pool.query(`update sol_coins set status = $2, note = $3, checked_at = now() where mint = $1`, [r.mint, status, c.why]);
        if (status === "bad") log(`sol: ${r.mint} not listed (${c.why})`);
      }
    } catch (e) {
      await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]).catch(() => {});
      log(`sol: check ${r.mint} failed (${e?.message ?? e})`);
    }
  }
}

// ------------------------------------------------------------------ payouts

async function payouts(pool, S, log) {
  const { web3, pump, conn, keeper } = S;
  if (!keeper) return;
  const { rows } = await pool.query(
    `select mint, creator, full_at from sol_coins
     where status = 'live' and kind = 'pump' and (paid_at is null or paid_at < now() - interval '30 minutes')
       and (checked_at is null or checked_at < now() - interval '30 minutes')
     order by checked_at nulls first limit 100`
  );
  if (!rows.length) return;
  // cheap look first: what's waiting in each coin's shared fee vault (and on its curve)
  const keys = rows.flatMap((r) => {
    const mint = new web3.PublicKey(r.mint);
    return [pump.creatorVaultPda(pump.feeSharingConfigPda(mint)), pump.bondingCurvePda(mint)];
  });
  const infos = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  const rent = 890_880; // a plain account's rent floor
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const vault = infos[i * 2];
    const curveInfo = infos[i * 2 + 1];
    let waiting = Math.max(0, (vault?.lamports ?? 0) - rent);
    try {
      // creator fees some trades leave on the curve until they're swept (part of every payout)
      const curve = curveInfo ? pump.PUMP_SDK.decodeBondingCurve(curveInfo) : null;
      if (curve?.creatorFee) waiting += Number(curve.creatorFee.toString());
    } catch {}
    // graduated coins collect their fees elsewhere (the pool): those show up in the full look
    const fullDue = !r.full_at || Date.now() - new Date(r.full_at).getTime() > FULL_CHECK_EVERY_MS;
    if (waiting < S.minPayout && !fullDue) {
      await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]);
      continue;
    }
    try {
      // the split must still be 50/50 before anything is paid
      const c = await checkSplit(S, r);
      if (!c.ok) {
        // a node that is behind can miss an account for a moment: only a split read and found
        // wrong delists a coin
        if (c.missing) {
          await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]);
          continue;
        }
        await pool.query(`update sol_coins set status = 'bad', note = $2, checked_at = now() where mint = $1`, [r.mint, c.why]);
        log(`sol: ${r.mint} delisted (${c.why})`);
        continue;
      }
      const mint = new web3.PublicKey(r.mint);
      const min = await S.sdk.getMinimumDistributableFee(mint, keeper.publicKey, { payer: keeper.publicKey });
      const amount = Number(min.distributableFees.toString());
      if (min.canDistribute && amount >= S.minPayout) {
        const built = await S.sdk.buildDistributeCreatorFeesInstructions(mint, { payer: keeper.publicKey });
        let sig;
        try {
          sig = await sendIxs(S, built.instructions, S.alt);
        } catch (e) {
          // too big for one: sweeps first, then the payout
          if (!built.sweepCount) throw e;
          await sendIxs(S, built.instructions.slice(0, built.sweepCount), S.alt);
          sig = await sendIxs(S, built.instructions.slice(built.sweepCount), S.alt);
        }
        await pool.query(
          `update sol_coins set paid_at = now(), checked_at = now(), full_at = now(), paid_lamports = paid_lamports + $2, payouts = payouts + 1, locked = $3 where mint = $1`,
          [r.mint, amount, c.locked]
        );
        log(`sol: paid out ${(amount / 1e9).toFixed(4)} SOL for ${r.mint} (${sig})`);
      } else {
        await pool.query(`update sol_coins set checked_at = now(), full_at = now(), locked = $2 where mint = $1`, [r.mint, c.locked]);
      }
    } catch (e) {
      await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]).catch(() => {});
      log(`sol: payout ${r.mint} failed (${e?.message ?? e})`);
    }
  }
}

// ------------------------------------------------------------------ prices

let solUsd = { v: null, at: 0 };
async function solPrice() {
  if (solUsd.v && Date.now() - solUsd.at < 60_000) return solUsd.v;
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(8000) });
    const p = Number((await r.json())?.data?.amount);
    if (Number.isFinite(p) && p > 0) solUsd = { v: p, at: Date.now() };
  } catch {}
  return solUsd.v;
}

/** Price and market cap of sasa's own coins from their launch curve (before DexScreener has them). */
async function curvePrices(pool, S) {
  const { web3, pump, conn } = S;
  const usd = await solPrice();
  if (!usd) return;
  const { rows } = await pool.query(
    `select mint from sol_coins where status = 'live' and kind = 'pump' and coalesce(curve_done, false) = false
     order by created_at desc limit 300`
  );
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((r) => pump.bondingCurvePda(new web3.PublicKey(r.mint))), "confirmed");
    for (let j = 0; j < chunk.length; j++) {
      try {
        if (!infos[j]) continue;
        const c = pump.PUMP_SDK.decodeBondingCurve(infos[j]);
        const vq = Number(c.virtualQuoteReserves.toString()) / 1e9; // SOL
        const vt = Number(c.virtualTokenReserves.toString()) / 1e6; // tokens (6 decimals)
        const supply = Number(c.tokenTotalSupply.toString()) / 1e6;
        if (c.complete || vt <= 0) {
          await pool.query(`update sol_coins set curve_done = true where mint = $1`, [chunk[j].mint]);
          continue;
        }
        const price = (vq / vt) * usd;
        await pool.query(`update sol_coins set price_usd = $2, mcap_usd = $3, priced_at = now() where mint = $1`, [chunk[j].mint, price, price * supply]);
      } catch {}
    }
  }
}

// ------------------------------------------------------------------ sasa's own-fee coins (soldbc.mjs)

/** Claims sasa's part of every own-fee coin's trading fees into the treasury, each coin every half hour at most. */
async function dbcPayouts(pool, S, log) {
  if (!S.keeper || !S.dbcConfig) return;
  const { rows } = await pool.query(
    `select mint from sol_coins
     where status = 'live' and kind = 'dbc'
       and (paid_at is null or paid_at < now() - interval '30 minutes')
       and (checked_at is null or checked_at < now() - interval '10 minutes')
     order by checked_at nulls first limit 50`
  );
  for (const r of rows) {
    try {
      const amount = await claimDbc(S, r, sendIxs);
      if (amount > 0) {
        await pool.query(
          `update sol_coins set paid_at = now(), checked_at = now(), paid_lamports = paid_lamports + $2, payouts = payouts + 1 where mint = $1`,
          [r.mint, amount]
        );
        log(`sol: claimed ${(amount / 1e9).toFixed(4)} SOL of own-fee coin ${r.mint} to the treasury`);
      } else await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]);
    } catch (e) {
      await pool.query(`update sol_coins set checked_at = now() where mint = $1`, [r.mint]).catch(() => {});
      log(`sol: own-fee claim ${r.mint} failed (${e?.message ?? e})`);
    }
  }
}

/** Price and market cap of the own-fee coins from their curve (before DexScreener has them). */
async function dbcPrices(pool, S) {
  if (!S.dbcConfig) return;
  const usd = await solPrice();
  if (!usd) return;
  const { rows } = await pool.query(
    `select mint from sol_coins where status = 'live' and kind = 'dbc' and coalesce(curve_done, false) = false
     order by created_at desc limit 100`
  );
  for (const r of rows) {
    try {
      const p = await dbcPool(S, r.mint);
      if (!p) continue;
      if (p.state.isMigrated) {
        await pool.query(`update sol_coins set curve_done = true where mint = $1`, [r.mint]);
        continue;
      }
      const price = dbcPriceSol(p.state) * usd;
      await pool.query(`update sol_coins set price_usd = $2, mcap_usd = $3, priced_at = now() where mint = $1`, [r.mint, price, price * 1e9]);
    } catch {}
  }
}

// ------------------------------------------------------------------ lookup table

/** Every account a launch uses that is the same for every launch (programs, global accounts, fee wallets). */
async function launchConstants(S, global) {
  const { web3, pump, treasury } = S;
  const BN = require("bn.js");
  const one = async () => {
    const user = web3.Keypair.generate().publicKey;
    const mint = web3.Keypair.generate().publicKey;
    const base = { global, mint, name: "x", symbol: "x", uri: "x", user, amount: new BN(1), solAmount: new BN(1), mayhemMode: false };
    const [create, ata] = await pump.PUMP_SDK.createV2AndBuyInstructions({ ...base, creator: user });
    const buy = (await pump.PUMP_SDK.createV2AndBuyInstructions({ ...base, creator: pump.feeSharingConfigPda(mint) }))[2];
    const open = await pump.PUMP_SDK.createFeeSharingConfig({ creator: user, mint, pool: null });
    const fix = await pump.PUMP_SDK.updateFeeShares({
      authority: user,
      mint,
      currentShareholders: [user],
      newShareholders: [
        { address: treasury, shareBps: SHARE },
        { address: user, shareBps: SHARE },
      ],
      bondingCurveComplete: false,
    });
    const ixs = [create, ata, buy, open, fix];
    return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
  };
  const [a, b] = await Promise.all([one(), one()]);
  const out = new Set([...a].filter((k) => b.has(k)));
  // every wallet a buy may pay a fee to (picked at random per buy)
  for (const k of [global.feeRecipient, ...(global.feeRecipients ?? []), ...(global.buybackFeeRecipients ?? [])]) {
    if (k && !k.equals(web3.PublicKey.default)) out.add(k.toBase58());
  }
  out.add(web3.ComputeBudgetProgram.programId.toBase58());
  out.add(treasury.toBase58());
  return [...out];
}

async function keepLookupTable(pool, S, log) {
  const { web3, conn, keeper } = S;
  if (!keeper) return;
  const global = await S.sdk.fetchGlobal();
  const want = await launchConstants(S, global);
  // the table in use, or one made earlier whose filling didn't finish
  const saved =
    (await pool.query(`select value from sol_config where key = 'alt'`)).rows[0]?.value ??
    (await pool.query(`select value from sol_config where key = 'alt_pending'`)).rows[0]?.value ??
    null;
  let address = saved ? new web3.PublicKey(saved) : null;
  let have = [];
  if (address) {
    const t = (await conn.getAddressLookupTable(address)).value;
    if (!t || !t.state.authority || !t.state.authority.equals(keeper.publicKey)) {
      log("sol: the saved lookup table is gone or not ours; making a new one");
      address = null;
    } else have = t.state.addresses.map((k) => k.toBase58());
  }
  if (!address) {
    const slot = await conn.getSlot("finalized");
    const [ix, addr] = web3.AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot });
    await sendIxs(S, [ix]);
    address = addr;
    // saved at once, so a failure below continues with this table instead of making another
    await pool.query(`insert into sol_config (key, value) values ('alt_pending', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [addr.toBase58()]);
    log(`sol: made lookup table ${addr.toBase58()}`);
  }
  const missing = want.filter((k) => !have.includes(k));
  for (let i = 0; i < missing.length; i += 20) {
    const ix = web3.AddressLookupTableProgram.extendLookupTable({
      lookupTable: address,
      authority: keeper.publicKey,
      payer: keeper.publicKey,
      addresses: missing.slice(i, i + 20).map((k) => new web3.PublicKey(k)),
    });
    await sendIxs(S, [ix]);
  }
  if (missing.length) log(`sol: lookup table has ${have.length + missing.length} addresses`);
  const current = (await pool.query(`select value from sol_config where key = 'alt'`)).rows[0]?.value ?? null;
  if (address.toBase58() !== current) {
    // usable from the next slot on; give it a moment before the site starts using it
    await sleep(3000);
    await pool.query(`insert into sol_config (key, value) values ('alt', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [address.toBase58()]);
  }
  S.alt = (await conn.getAddressLookupTable(address)).value;
}

// ------------------------------------------------------------------ the loop

export async function solKeeperLoop(pool, log) {
  if (process.env.SOLKEEPER_OFF === "1") return log("sol keeper off (SOLKEEPER_OFF=1)");
  await pool.query(SQL);
  await ensureSasaSolView(pool).catch((e) => log(`sol: view (${e?.message ?? e})`));
  const treasuryRaw = String(process.env.SOLANA_TREASURY || "").trim();
  if (!treasuryRaw) {
    log("sol keeper waiting: set SOLANA_TREASURY (and SOLANA_RPC_URL, SOLANA_KEEPER_KEY) to turn it on");
    return;
  }
  const web3 = require("@solana/web3.js");
  const pump = require("@pump-fun/pump-sdk");
  const conn = new web3.Connection(process.env.SOLANA_RPC_URL || PUBLIC_RPC, { commitment: "confirmed" });
  const S = {
    web3,
    pump,
    conn,
    sdk: new pump.OnlinePumpSdk(conn),
    treasury: new web3.PublicKey(treasuryRaw),
    keeper: keeperKeypair(web3, process.env.SOLANA_KEEPER_KEY),
    minPayout: Math.round(Number(process.env.SOL_MIN_PAYOUT || 0.005) * 1e9),
    alt: null,
    // sasa's own-fee launches (soldbc.mjs): the SDK and the config, once made
    D: dbcSdk(),
    dbc: null,
    dbcConfig: null,
  };
  // the site reads the treasury from here: one setting (Railway) for both
  await pool.query(`insert into sol_config (key, value) values ('treasury', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [S.treasury.toBase58()]);
  log(`sol keeper on (treasury ${S.treasury.toBase58()}, ${S.keeper ? `keeper ${S.keeper.publicKey.toBase58()}` : "no keeper key: checks only, no payouts"})`);
  let lastPayout = 0;
  let lastPrices = 0;
  let lastTable = 0;
  let lastLow = 0;
  let lastNote = 0;
  let lastDbc = 0;
  for (;;) {
    // sasa's own-fee config: made once (the keeper pays ~0.01 SOL), then only read
    // (tried again every 2 minutes until it's loaded)
    if (S.keeper && !S.dbcConfig && Date.now() - lastDbc > 120_000) {
      lastDbc = Date.now();
      await ensureDbcConfig(pool, S, log, sendIxs).catch((e) => log(`sol: own-fee config failed (${e?.message ?? e})`));
    }
    try {
      await checkNew(pool, S, log);
    } catch (e) {
      log(`sol: check failed (${e?.message ?? e})`);
    }
    if (Date.now() - lastPrices > 60_000) {
      lastPrices = Date.now();
      await curvePrices(pool, S).catch((e) => log(`sol: prices failed (${e?.message ?? e})`));
      await dbcPrices(pool, S).catch((e) => log(`sol: own-fee prices failed (${e?.message ?? e})`));
    }
    if (S.keeper && Date.now() - lastTable > 12 * 3600_000) {
      try {
        await keepLookupTable(pool, S, log);
        lastTable = Date.now();
      } catch (e) {
        lastTable = Date.now() - 11 * 3600_000; // try again in an hour
        log(`sol: lookup table failed (${e?.message ?? e})`);
      }
    }
    if (S.keeper && Date.now() - lastPayout > 60_000) {
      lastPayout = Date.now();
      try {
        await payouts(pool, S, log);
      } catch (e) {
        log(`sol: payouts failed (${e?.message ?? e})`);
      }
      await dbcPayouts(pool, S, log).catch((e) => log(`sol: own-fee claims failed (${e?.message ?? e})`));
      // the keeper's own SOL pays the network fees: say so when it runs low
      if (Date.now() - lastLow > 6 * 3600_000) {
        const bal = await conn.getBalance(S.keeper.publicKey).catch(() => null);
        if (bal !== null && bal < 50_000_000) {
          lastLow = Date.now();
          const addr = S.keeper.publicKey.toBase58();
          log(`sol: keeper wallet ${addr} is low (${(bal / 1e9).toFixed(4)} SOL): top it up`);
          // the admin hears it too (🔔 on the site, pushed to the phone), at most once a day
          if (Date.now() - lastNote > 24 * 3600_000) {
            lastNote = Date.now();
            const admins = (process.env.ADMINS || "0xe0ba5905940d748b23dc01266aa884e2391cca2f,0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b,0xf4bc1b22e117a621e1118d09f7bb015c685a9617")
              .split(",")
              .map((x) => x.trim().toLowerCase())
              .filter((x) => /^0x[0-9a-f]{40}$/.test(x));
            await pool
              .query(
                `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
                 select a, null, 'system', $2, $3, $4, false from unnest($1::text[]) a`,
                [
                  admins,
                  "⚠️ Solana payout wallet is low",
                  `It has ${(bal / 1e9).toFixed(4)} SOL left. Send about 0.05 SOL to ${addr} so creator-fee payouts keep running.`,
                  `https://solscan.io/account/${addr}`,
                ]
              )
              .catch((e) => log(`sol: low-balance note failed (${e?.message ?? e})`));
          }
        }
      }
    }
    await sleep(CHECK_MS);
  }
}
