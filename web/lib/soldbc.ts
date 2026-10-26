/**
 * sasa's own-fee Solana launches (admin test, Oct 2026): coins on Meteora's launch curve with
 * sasa's fee settings (one on-chain config made by the keeper: indexer/soldbc.mjs). Loaded only
 * when it's used (the libraries are big).
 *
 * Trading fee on every buy and sell, counted from the second the coin goes live, and shown in
 * the trade box before anyone trades:
 *
 *     0–30 s 30%  ·  30–60 s 15.5%  ·  then 1%      (the creator's first buy, in the launch, pays 1%)
 *
 * The pieces that build transactions take a Connection, so the same code runs in the offline
 * test; the wrappers at the bottom use the site's Solana connection and the user's signer.
 */
import "./bufferpoly";
import { ComputeBudgetProgram, Keypair, PublicKey, type Connection, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { budget, compile, priorityFee, sendAndConfirm, signAll, solConfig, solConnection, type SolSigner } from "./sollaunch";

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
/** Kept on top of the first buy for the new accounts (coin, pool, vaults, picture info) and network fees (~0.023 SOL used). */
export const DBC_RESERVE_LAMPORTS = 40_000_000n; // 0.04 SOL

const clients = new WeakMap<Connection, DynamicBondingCurveClient>();
const clientFor = (c: Connection) => {
  let x = clients.get(c);
  if (!x) clients.set(c, (x = new DynamicBondingCurveClient(c, "confirmed")));
  return x;
};
/** A transaction's instructions without the SDK's own compute-budget ones (sasa sets its own). */
const ixsOf = (tx: Transaction): TransactionInstruction[] => tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

/** The instructions of a launch: the coin, its pool under sasa's config and the creator's first buy (all or nothing). */
export async function dbcLaunchIxs(
  c: Connection,
  o: { config: PublicKey; creator: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string; buyLamports: bigint }
): Promise<TransactionInstruction[]> {
  const tx = await clientFor(c).creator.createPoolWithFirstBuy({
    createPoolParam: { baseMint: o.mint, config: o.config, name: o.name, symbol: o.symbol, uri: o.uri, payer: o.creator, poolCreator: o.creator },
    // the first buy runs in the same transaction as the launch: nothing can trade in between
    firstBuyParam:
      o.buyLamports > 0n ? { buyer: o.creator, buyAmount: new BN(o.buyLamports.toString()), minimumAmountOut: new BN(1), referralTokenAccount: null } : undefined,
  });
  return ixsOf(tx);
}

export type DbcPool = { address: PublicKey; pool: NonNullable<Awaited<ReturnType<DynamicBondingCurveClient["state"]["getPool"]>>>; config: NonNullable<Awaited<ReturnType<DynamicBondingCurveClient["state"]["getPoolConfig"]>>> };

/** The coin's pool under sasa's config, while it still trades on the curve (null otherwise). */
export async function dbcPoolOf(c: Connection, config: PublicKey, mint: PublicKey): Promise<DbcPool | null> {
  const client = clientFor(c);
  const address = deriveDbcPoolAddress(WSOL, mint, config);
  const [pool, cfg] = await Promise.all([client.state.getPool(address), client.state.getPoolConfig(config)]);
  if (!pool || !cfg || pool.poolState.isMigrated) return null;
  return { address, pool, config: cfg };
}

/**
 * The trading fee right now (basis points), the next one and when it starts (seconds; null when
 * the fee won't change any more). Read from the config itself, so it's what the chain charges.
 */
export function dbcFeeAt(p: DbcPool, nowSec: number): { bps: number; nextBps: number | null; inSec: number | null } {
  const f = p.config.poolFees.baseFee;
  const cliff = Number(f.cliffFeeNumerator.toString());
  const periods = Number(f.firstFactor.toString());
  const every = Number(f.secondFactor.toString());
  const cut = Number(f.thirdFactor.toString());
  const since = Math.max(0, nowSec - Number(p.pool.poolState.activationPoint.toString()));
  const step = every > 0 ? Math.min(periods, Math.floor(since / every)) : periods;
  const at = (n: number) => Math.round((cliff - cut * n) / 1e5); // numerator (1e9 = 100%) → bps
  if (step >= periods) return { bps: at(periods), nextBps: null, inSec: null };
  return { bps: at(step), nextBps: at(step + 1), inSec: (step + 1) * every - since };
}

/** A buy (lamports of SOL in) or a sale (raw coin amount in), priced now with `slippageBps` of room. */
export async function dbcSwapIxs(
  c: Connection,
  p: DbcPool,
  o: { owner: PublicKey; sell: boolean; amountIn: bigint; slippageBps: number; nowSec: number }
): Promise<{ ixs: TransactionInstruction[]; out: bigint; min: bigint }> {
  const client = clientFor(c);
  const amountIn = new BN(o.amountIn.toString());
  const q = client.pool.swapQuote2({
    virtualPool: p.pool,
    config: p.config,
    swapBaseForQuote: o.sell,
    hasReferral: false,
    // only a launch's own first buy (sent with it) pays the lowest fee; every later trade pays the schedule
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN(o.nowSec),
    slippageBps: o.slippageBps,
    swapMode: SwapMode.ExactIn,
    amountIn,
  });
  if (!q.minimumAmountOut) throw new Error("Couldn't price this trade. Try again.");
  const minimumAmountOut = q.minimumAmountOut;
  const tx = await client.pool.swap2({
    owner: o.owner,
    pool: p.address,
    swapBaseForQuote: o.sell,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
  });
  return { ixs: ixsOf(tx), out: BigInt(q.outputAmount.toString()), min: BigInt(minimumAmountOut.toString()) };
}

// ------------------------------------------------------------------ the site's wrappers


/** sasa's own-fee config (null until the keeper has made it). */
async function configAddress(): Promise<PublicKey | null> {
  const cfg = await solConfig();
  return cfg.dbc ? new PublicKey(cfg.dbc) : null;
}

/** Launches the coin with its first buy in one transaction; returns the coin's address and the transaction id. */
export async function dbcLaunch(o: {
  signer: SolSigner;
  mint: Keypair;
  name: string;
  symbol: string;
  uri: string;
  buyLamports: bigint;
  onStep?: (m: string) => void;
}): Promise<{ mint: string; sig: string }> {
  const config = await configAddress();
  if (!config) throw new Error("This launch type isn't ready yet. Try again in a few minutes.");
  const c = solConnection();
  const creator = new PublicKey(o.signer.address);
  const ixs = await dbcLaunchIxs(c, { config, creator, mint: o.mint.publicKey, name: o.name, symbol: o.symbol, uri: o.uri, buyLamports: o.buyLamports });
  const [price, bh] = await Promise.all([priorityFee(), c.getLatestBlockhash("confirmed")]);
  const tx = compile(creator, [...budget(400_000, price), ...ixs], bh.blockhash, null);
  if (!tx) throw new Error("The launch got too big. Use a shorter name.");
  // checked before signing (nothing is spent on a launch the chain would refuse); an admin test,
  // so the chain's own reason is shown in full
  o.onStep?.("Checking…");
  tx.sign([o.mint]);
  const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err) {
    const all = sim.value.logs ?? [];
    // the program's own reason (Anchor names the file and line), then the instruction it was in
    const why = all.find((l) => /AnchorError/.test(l)) ?? all.filter((l) => /error|failed|insufficient/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
    const ix = all.filter((l) => /Instruction:/.test(l)).slice(-1)[0] ?? "";
    console.warn("sasa: own-fee launch check failed", o.buyLamports.toString(), sim.value.err, all);
    throw new Error(`${why.replace(/^Program log: /, "").slice(0, 150)} [${ix.replace(/^Program log: Instruction: /, "")}, buy ${o.buyLamports}]`);
  }
  o.onStep?.("Creating your coin…");
  const sig = await sendAndConfirm(await signAll(tx, o.signer, [o.mint]), bh.lastValidBlockHeight, o.onStep);
  return { mint: o.mint.publicKey.toBase58(), sig };
}

/** The coin's pool when it is one of sasa's own-fee coins still on its curve. */
export async function dbcActive(mint: string): Promise<DbcPool | null> {
  try {
    const config = await configAddress();
    return config ? await dbcPoolOf(solConnection(), config, new PublicKey(mint)) : null;
  } catch {
    return null;
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** The fee a trade pays right now (for the trade box). */
export async function dbcFeeNow(mint: string) {
  const p = await dbcActive(mint);
  return p ? dbcFeeAt(p, now()) : null;
}

async function swap(signer: SolSigner, mint: string, sell: boolean, amountIn: bigint, onStep?: (m: string) => void): Promise<bigint> {
  const c = solConnection();
  const p = await dbcActive(mint);
  if (!p) throw new Error("This coin has moved to its pool. Try again.");
  const owner = new PublicKey(signer.address);
  const { ixs, out } = await dbcSwapIxs(c, p, { owner, sell, amountIn, slippageBps: 300, nowSec: now() });
  if (out <= 0n) throw new Error(sell ? "That amount is too small to sell." : "That amount is too small to buy.");
  const [price, bh] = await Promise.all([priorityFee(), c.getLatestBlockhash("confirmed")]);
  const tx = compile(owner, [...budget(250_000, price), ...ixs], bh.blockhash, null);
  if (!tx) throw new Error(sell ? "Couldn't build the sale. Try again." : "Couldn't build the buy. Try again.");
  onStep?.(sell ? "Selling…" : "Buying…");
  await sendAndConfirm(await signAll(tx, signer, []), bh.lastValidBlockHeight, onStep);
  return out;
}

/** Buys with `lamports` of the wallet's SOL. */
export async function dbcBuy(signer: SolSigner, mint: string, lamports: bigint, onStep?: (m: string) => void): Promise<void> {
  await swap(signer, mint, false, lamports, onStep);
}

/** Sells `amount` (raw) for SOL into the same wallet; returns the SOL (lamports) expected. */
export async function dbcSell(signer: SolSigner, mint: string, amount: bigint, onStep?: (m: string) => void): Promise<bigint> {
  return swap(signer, mint, true, amount, onStep);
}
