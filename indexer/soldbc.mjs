/**
 * sasa's own-fee Solana launches (admin test, Oct 2026): coins on Meteora's launch curve
 * (Dynamic Bonding Curve) with sasa's fee settings instead of the standard launch curve.
 *
 * The fee settings live in one on-chain "config" that the keeper makes once (it pays the rent and
 * is its fee claimer; nobody can change a config after it's made):
 *
 *   trading fee, on every buy and sell, counted from the second the coin goes live:
 *       0–30 s   30%
 *       30–60 s  15.5%
 *       60 s on  1%            (the creator's own first buy, made in the launch itself, pays 1%)
 *   who gets it: Meteora 20%, then of the other 80%: the creator 37%, sasa 63%
 *       (so about 29.6% of every fee to the creator, 50.4% to sasa)
 *   the curve: starts at 30 SOL market cap, moves to its Meteora pool at 400 SOL (like the
 *       standard launch curve); the pool's liquidity is locked for good (sasa 63%, creator 37%)
 *
 * The keeper claims sasa's part of each coin's fees into the treasury every half hour
 * (indexer/solkeeper.mjs). The creator claims theirs on chain.
 *
 * Exported for solkeeper.mjs and the offline test (the parameters are the same in both).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const DBC_SCHEDULE = { startBps: 3000, endBps: 100, periods: 2, seconds: 60 };
export const DBC_CREATOR_PCT = 37;

/** The config's parameters (Meteora's curve builder does the curve math). */
export function sasaDbcParams(D) {
  return D.buildCurveWithMarketCap({
    token: {
      tokenType: D.TokenType.SPLToken,
      tokenBaseDecimal: D.TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: D.TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: D.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: DBC_SCHEDULE.startBps,
          endingFeeBps: DBC_SCHEDULE.endBps,
          numberOfPeriod: DBC_SCHEDULE.periods,
          totalDuration: DBC_SCHEDULE.seconds,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: D.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: DBC_CREATOR_PCT,
      poolCreationFee: 0,
      // the creator's first buy, sent in the same transaction as the launch, pays the lowest fee
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: D.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: D.MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 63,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 37,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: D.ActivationType.Timestamp,
    initialMarketCap: 30,
    migrationMarketCap: 400,
  });
}

export function dbcSdk() {
  return require("@meteora-ag/dynamic-bonding-curve-sdk");
}

export const WSOL = "So11111111111111111111111111111111111111112";

/** Instructions of a legacy transaction the SDK built, without its own compute-budget ones. */
export function ixsOf(web3, tx) {
  return tx.instructions.filter((ix) => !ix.programId.equals(web3.ComputeBudgetProgram.programId));
}

/**
 * sasa's config: the one saved in sol_config when it is on chain with the keeper as its fee
 * claimer, otherwise a new one (made once). Sets S.dbcConfig (a PublicKey) or leaves it null.
 */
export async function ensureDbcConfig(pool, S, log, sendIxs) {
  const { web3, conn, keeper, treasury } = S;
  if (!keeper) return;
  const D = S.D;
  const client = (S.dbc ??= new D.DynamicBondingCurveClient(conn, "confirmed"));
  const saved =
    (await pool.query(`select value from sol_config where key = 'dbc_config'`)).rows[0]?.value ??
    (await pool.query(`select value from sol_config where key = 'dbc_config_pending'`)).rows[0]?.value ??
    null;
  if (saved) {
    // a failed read throws (never taken as "not there"): a new config would orphan every coin
    // made under the saved one. Only a config that really isn't on chain is made again.
    const info = await conn.getAccountInfo(new web3.PublicKey(saved), "confirmed");
    if (info) {
      const cfg = await client.state.getPoolConfig(saved);
      if (!cfg || !cfg.feeClaimer.equals(keeper.publicKey)) throw new Error(`saved dbc config ${saved} isn't the keeper's: check sol_config`);
      S.dbcConfig = new web3.PublicKey(saved);
      await pool.query(`insert into sol_config (key, value) values ('dbc_config', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [saved]);
      return;
    }
  }
  const config = web3.Keypair.generate();
  // saved before sending: a send that times out but lands is picked up next time
  await pool.query(`insert into sol_config (key, value) values ('dbc_config_pending', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [config.publicKey.toBase58()]);
  const tx = await client.partner.createConfig2({
    payer: keeper.publicKey,
    config: config.publicKey,
    feeClaimer: keeper.publicKey,
    leftoverReceiver: treasury,
    quoteMint: new web3.PublicKey(WSOL),
    ...sasaDbcParams(D),
    transferFeeParameters: null,
  });
  await sendIxs(S, ixsOf(web3, tx), null, [config]);
  await pool.query(`insert into sol_config (key, value) values ('dbc_config', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`, [config.publicKey.toBase58()]);
  S.dbcConfig = config.publicKey;
  log(`sol: made sasa's own-fee launch config ${config.publicKey.toBase58()}`);
}

/** The coin's pool under sasa's config (null when there's none). */
export async function dbcPool(S, mint) {
  const { web3 } = S;
  if (!S.dbcConfig) return null;
  const address = S.D.deriveDbcPoolAddress(new web3.PublicKey(WSOL), new web3.PublicKey(mint), S.dbcConfig);
  const state = (await S.dbc.state.getPool(address))?.poolState;
  return state ? { address, state } : null;
}

/** "ok" when the coin is on chain in a pool under sasa's own config; `missing` when not (yet). */
export async function checkDbc(S, row) {
  const p = await dbcPool(S, row.mint);
  if (!p) return { ok: false, why: "no coin", missing: true };
  if (!p.state.config.equals(S.dbcConfig)) return { ok: false, why: "not sasa's config", final: true };
  return { ok: true, creator: p.state.creator.toBase58(), locked: true };
}

/** Claims sasa's part of a coin's fees (in SOL) to the treasury; returns the lamports claimed (0 when below the minimum). */
export async function claimDbc(S, row, sendIxs) {
  const { web3, keeper, treasury } = S;
  const p = await dbcPool(S, row.mint);
  if (!p) return 0;
  const waiting = BigInt(p.state.partnerQuoteFee.toString());
  if (waiting < BigInt(S.minPayout)) return 0;
  const BN = require("bn.js");
  const tx = await S.dbc.partner.claimPartnerTradingFeeToReceiver({
    pool: p.address,
    feeClaimer: keeper.publicKey,
    payer: keeper.publicKey,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN(waiting.toString()),
    receiver: treasury,
  });
  await sendIxs(S, ixsOf(web3, tx));
  return Number(waiting);
}

/** Price (SOL per whole token) of a curve pool, from its square-root price (6-decimal coin, SOL quote). */
export function dbcPriceSol(state) {
  const sqrt = Number(state.sqrtPrice.toString()) / 2 ** 64;
  return sqrt * sqrt * 1e-3;
}
