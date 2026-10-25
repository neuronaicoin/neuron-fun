/**
 * A coin launch on Solana (only loaded when someone launches there: these libraries are big).
 *
 * The coin is made on the standard Solana launch curve (the program every Solana app already
 * reads, so explorers, DexScreener, GMGN and wallets show it with its picture at once). In the
 * same launch, the coin's creator fees are set to be shared, fixed for good:
 *
 *     50% sasa (its Solana treasury, SOLANA_TREASURY on the server)
 *     50% the creator
 *
 * The curve's program allows that split to be set only once; after it, nobody (not the creator,
 * not sasa) can change it. sasa's keeper (indexer/solkeeper.mjs) checks every coin on chain and
 * pays both sides out every half hour.
 *
 * One transaction when sasa's lookup table is ready (create + fee split + first buy, all or
 * nothing). Without it, two: (1) create + open the fee split, (2) fix the split + first buy;
 * if (2) doesn't go through, `finishLaunch` sends it again (only the creator's signature needed).
 */
import "./bufferpoly";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  type Global,
} from "@pump-fun/pump-sdk";
import { SOL_RPC } from "./solana";

/** Who signs on Solana: the email account's own Solana wallet, or Phantom & co. */
export type SolSigner = { address: string; sign: (tx: Uint8Array) => Promise<Uint8Array> };

/** Kept on top of the first buy for the new accounts (coin, curve, fee split…) and network fees. */
export const LAUNCH_RESERVE_LAMPORTS = 25_000_000n; // 0.025 SOL
const MAX_TX = 1232;
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NATIVE_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SHARE_BPS = 5000;

let conn: Connection | null = null;
export function solConnection(): Connection {
  if (!conn) conn = new Connection(new URL(SOL_RPC, window.location.origin).toString(), { commitment: "confirmed", disableRetryOnRateLimit: true });
  return conn;
}

export type SolConfig = { treasury: string | null; alt: string | null };
export async function solConfig(): Promise<SolConfig> {
  const r = await fetch("/api/sol/config");
  const j = (await r.json().catch(() => ({}))) as Partial<SolConfig> & { error?: string };
  if (!r.ok) throw new Error(j.error ?? "Couldn't reach sasa. Try again in a moment.");
  return { treasury: j.treasury ?? null, alt: j.alt ?? null };
}

export type CoinInfo = { name: string; symbol: string; description: string; image: string; twitter?: string; telegram?: string; website?: string };
/** Stores the coin's picture and info where Solana apps read them; returns the info's address. */
export async function uploadCoinInfo(info: CoinInfo): Promise<{ uri: string; image: string }> {
  const r = await fetch("/api/sol/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(info) });
  const j = (await r.json().catch(() => ({}))) as { uri?: string; image?: string; error?: string };
  if (!r.ok || !j.uri || !j.image) throw new Error(j.error ?? "Couldn't save the coin's picture. Try again.");
  return { uri: j.uri, image: j.image };
}

export async function solBalance(address: string): Promise<bigint> {
  return BigInt(await solConnection().getBalance(new PublicKey(address), "confirmed"));
}

/** Network priority fee (micro-lamports per compute unit): what recent launches paid, within bounds. */
export async function priorityFee(): Promise<number> {
  try {
    const fees = await solConnection().getRecentPrioritizationFees({ lockedWritableAccounts: [PUMP_PROGRAM_ID] });
    const v = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const p75 = v.length ? v[Math.floor(v.length * 0.75)] : 0;
    return Math.min(2_000_000, Math.max(100_000, p75));
  } catch {
    return 200_000;
  }
}

function compile(payer: PublicKey, ixs: TransactionInstruction[], blockhash: string, alt: AddressLookupTableAccount | null): VersionedTransaction | null {
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []);
    const tx = new VersionedTransaction(msg);
    // too big for one Solana transaction: serialize() throws, or the bytes run over
    if (tx.serialize().length > MAX_TX) return null;
    return tx;
  } catch {
    return null;
  }
}

const budget = (units: number, price: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })];

/** Signs with the wallet, then with the coin's own key (kept last, so a wallet that rewrites the transaction can't drop it). */
export async function signAll(tx: VersionedTransaction, signer: SolSigner, extra: Keypair[]): Promise<VersionedTransaction> {
  const out = VersionedTransaction.deserialize(await signer.sign(tx.serialize()));
  if (extra.length) out.sign(extra);
  // every required signature must be there before it goes out
  const n = out.message.header.numRequiredSignatures;
  for (let i = 0; i < n; i++) if (!out.signatures[i] || out.signatures[i].every((b) => b === 0)) throw new Error("The wallet didn't sign. Try again.");
  return out;
}

const b58sig = (tx: VersionedTransaction) => {
  // base58 of the first signature = the transaction's id
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = tx.signatures[0];
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
};

/** Sends and waits until confirmed (sent again every 2 s; gives up when its blockhash runs out). */
/** Why Solana's check refused a transaction, in words a person can act on (from its logs). */
function refusedReason(e: unknown): string {
  const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = (err.logs ?? err.transactionLogs ?? []).join("\n");
  const all = `${err.message ?? ""}\n${logs}`;
  if (/insufficient (lamports|funds)|InsufficientFunds|0x1\b|rent/i.test(all))
    return "Your Solana wallet needs a little more SOL for the network fee. Try again: sasa adds it from your Cash.";
  if (/slippage|TooLittle|TooMuch|0x1771|0x1772|exceeds desired/i.test(all)) return "The price moved while sending. Try again.";
  if (/blockhash not found|BlockhashNotFound/i.test(all)) return "Solana was busy. Try again.";
  const last = logs.split("\n").reverse().find((l) => /failed|error/i.test(l));
  return `Solana refused it${last ? `: ${last.replace(/^Program \w+ /, "").slice(0, 120)}` : ". Try again in a moment."}`;
}

export async function sendAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number, onStep?: (m: string) => void): Promise<string> {
  const c = solConnection();
  const raw = tx.serialize();
  const sig = b58sig(tx);
  // the first send checks it (a clear error now instead of a silent drop later)
  try {
    await c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (e) {
    throw new Error(refusedReason(e));
  }
  onStep?.("Confirming…");
  const started = Date.now();
  let lastSend = Date.now();
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const st = (await c.getSignatureStatuses([sig]).catch(() => null))?.value?.[0] ?? null;
    if (st?.err) throw new Error(`Solana refused it: ${JSON.stringify(st.err).slice(0, 120)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (Date.now() - lastSend > 2000) {
      lastSend = Date.now();
      c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    if (i % 5 === 4) {
      const h = await c.getBlockHeight("confirmed").catch(() => 0);
      if (h > lastValidBlockHeight) {
        // one last look: it may have landed just now
        const late = (await c.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null))?.value?.[0];
        if (late && !late.err) return sig;
        throw new Error("Solana didn't take it in time. Nothing was spent on it: try again.");
      }
    }
    // a safety stop only (the blockhash check above normally ends it within ~90 s)
    if (Date.now() - started > 300_000) throw new Error("Solana is very slow right now. Wait a few minutes and check your coins before trying again.");
  }
}

export type LaunchPlan = {
  mint: Keypair;
  /** Tokens the first buy gets (0 for no first buy) and the SOL it may spend. */
  buyTokens: BN;
  buyLamports: BN;
  global: Global;
};

/** The instruction groups of a launch. */
async function launchParts(p: { plan: LaunchPlan; creator: PublicKey; treasury: PublicKey; name: string; symbol: string; uri: string }) {
  const { plan, creator, treasury } = p;
  const mint = plan.mint.publicKey;
  const base = { global: plan.global, mint, name: p.name, symbol: p.symbol, uri: p.uri, user: creator, amount: plan.buyTokens, solAmount: plan.buyLamports, mayhemMode: false };
  // create (+ the creator's coin account + a buy whose fees go to the creator: not used)
  const [create, ata] = await PUMP_SDK.createV2AndBuyInstructions({ ...base, creator });
  // the same buy, with the fees going to the shared split (the creator once the split exists)
  const buy = (await PUMP_SDK.createV2AndBuyInstructions({ ...base, creator: feeSharingConfigPda(mint) }))[2];
  const open = await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
  const fix = await PUMP_SDK.updateFeeShares({
    authority: creator,
    mint,
    currentShareholders: [creator],
    newShareholders: [
      { address: treasury, shareBps: SHARE_BPS },
      { address: creator, shareBps: 10_000 - SHARE_BPS },
    ],
    bondingCurveComplete: false,
  });
  const buys = plan.buyTokens.gtn(0) ? [ata, buy] : [];
  return { create, open, fix, buys };
}

/** Plans the first buy: `buyLamports` of SOL buys about this many tokens on a fresh curve. */
export async function planLaunch(buyLamports: bigint): Promise<LaunchPlan> {
  const sdk = new OnlinePumpSdk(solConnection());
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null)]);
  const lamports = new BN(buyLamports.toString());
  const buyTokens = lamports.gtn(0)
    ? getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports, quoteMint: PublicKey.default })
    : new BN(0);
  return { mint: Keypair.generate(), buyTokens, buyLamports: lamports, global };
}

/** SOL the creator's Solana wallet needs for this launch (first buy with its 1% room + the reserve). */
export function lamportsNeeded(plan: LaunchPlan): bigint {
  const buy = BigInt(plan.buyLamports.toString());
  return buy + buy / 100n + LAUNCH_RESERVE_LAMPORTS;
}

export type LaunchResult = { mint: string; sig: string; finished: boolean; bought: boolean };

/**
 * Launches the planned coin. `finished` is false only in two-step mode when step 2 didn't go
 * through: the coin exists, `finishLaunch(mint)` completes it.
 */
export async function sendLaunch(o: {
  plan: LaunchPlan;
  signer: SolSigner;
  config: SolConfig;
  name: string;
  symbol: string;
  uri: string;
  onStep?: (m: string) => void;
}): Promise<LaunchResult> {
  const { plan, signer, config } = o;
  if (!config.treasury) throw new Error("Solana launches aren't switched on yet.");
  const creator = new PublicKey(signer.address);
  const treasury = new PublicKey(config.treasury);
  if (creator.equals(treasury)) throw new Error("Launch from your own wallet, not sasa's.");
  const c = solConnection();
  const parts = await launchParts({ plan, creator, treasury, name: o.name, symbol: o.symbol, uri: o.uri });
  const [alt, price, bh] = await Promise.all([
    config.alt ? c.getAddressLookupTable(new PublicKey(config.alt)).then((r) => r.value).catch(() => null) : Promise.resolve(null),
    priorityFee(),
    c.getLatestBlockhash("confirmed"),
  ]);
  const mintKey = plan.mint.publicKey.toBase58();

  /**
   * Sends `ixs` as one transaction when it fits and the network's check passes: tried with room
   * to spare, then sent with what it really uses. null = too big, or the check failed (the
   * caller then splits it up).
   */
  const tryOne = async (ixs: TransactionInstruction[]): Promise<string | null> => {
    const trial = compile(creator, [...budget(1_400_000, price), ...ixs], bh.blockhash, alt);
    if (!trial) return null;
    o.onStep?.("Checking…");
    trial.sign([plan.mint]);
    const sim = await c.simulateTransaction(trial, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) {
      const why = simError(sim.value.err, sim.value.logs);
      if (/Not enough SOL/.test(why)) throw new Error(why);
      console.warn("sasa: Solana launch check failed, trying smaller steps:", why);
      return null;
    }
    const units = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed ?? 400_000) * 1.2) + 10_000);
    const tx = compile(creator, [...budget(units, price), ...ixs], bh.blockhash, alt);
    if (!tx) return null;
    o.onStep?.("Creating your coin…");
    return sendAndConfirm(await signAll(tx, signer, [plan.mint]), bh.lastValidBlockHeight, o.onStep);
  };
  const buyLamports = plan.buyTokens.gtn(0) ? plan.buyLamports : undefined;

  // 1. everything at once: create + fee split fixed + first buy
  const one = await tryOne([parts.create, parts.open, parts.fix, ...parts.buys]);
  if (one) return { mint: mintKey, sig: one, finished: true, bought: true };

  // 2. create + fee split fixed (nothing can come between them), then the first buy on its own
  if (parts.buys.length) {
    const two = await tryOne([parts.create, parts.open, parts.fix]);
    if (two) {
      const { bought } = await finishLaunch({ mint: mintKey, signer, config, buyLamports, onStep: o.onStep }).catch(() => ({ bought: false }));
      return { mint: mintKey, sig: two, finished: true, bought };
    }
  }

  // 3. create + open the split; then fix it (with a sweep if trades came in between); then buy
  const tx1 = compile(creator, [...budget(350_000, price), parts.create, parts.open], bh.blockhash, alt);
  if (!tx1) throw new Error("The launch got too big. Use a shorter name.");
  o.onStep?.("Creating your coin…");
  const signed1 = await signAll(tx1, signer, [plan.mint]);
  const sig = await sendAndConfirm(signed1, bh.lastValidBlockHeight, o.onStep);
  try {
    const { bought } = await finishLaunch({ mint: mintKey, signer, config, buyLamports, onStep: o.onStep });
    return { mint: mintKey, sig, finished: true, bought };
  } catch {
    return { mint: mintKey, sig, finished: false, bought: false };
  }
}

/**
 * Step 2 of a two-step launch (also used to finish one that stopped): fixes the 50/50 split,
 * then makes the first buy in a transaction of its own (a buy that fails because the price moved
 * never holds the split back). Returns whether the first buy went through.
 */
export async function finishLaunch(o: {
  mint: string;
  signer: SolSigner;
  config: SolConfig;
  /** SOL for the first buy (none: no buy). */
  buyLamports?: BN;
  onStep?: (m: string) => void;
}): Promise<{ bought: boolean }> {
  const { signer, config } = o;
  if (!config.treasury) throw new Error("Solana launches aren't switched on yet.");
  const c = solConnection();
  const creator = new PublicKey(signer.address);
  const treasury = new PublicKey(config.treasury);
  const mint = new PublicKey(o.mint);
  const [info, curveInfo] = await c.getMultipleAccountsInfo([feeSharingConfigPda(mint), bondingCurvePda(mint)], "confirmed");
  if (!info || !curveInfo) throw new Error("This coin isn't on Solana yet. Try again in a moment.");
  const split = PUMP_SDK.decodeSharingConfig(info);
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const done = split.shareholders.length === 2 && split.shareholders.some((s) => s.address.equals(treasury) && s.shareBps === SHARE_BPS);
  const [alt, price] = await Promise.all([
    config.alt ? c.getAddressLookupTable(new PublicKey(config.alt)).then((r) => r.value).catch(() => null) : Promise.resolve(null),
    priorityFee(),
  ]);
  if (!done) {
    const ixs: TransactionInstruction[] = [];
    // fees some trades left on the curve must be swept first, or the split can't be set
    if (!curve.creatorFee.isZero()) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint, creator: curve.creator, quoteMint: NATIVE_SOL_MINT }));
    ixs.push(
      await PUMP_SDK.updateFeeShares({
        authority: creator,
        mint,
        currentShareholders: split.shareholders.map((s) => s.address),
        newShareholders: [
          { address: treasury, shareBps: SHARE_BPS },
          { address: creator, shareBps: 10_000 - SHARE_BPS },
        ],
        bondingCurveComplete: curve.complete,
      })
    );
    const bh = await c.getLatestBlockhash("confirmed");
    const tx = compile(creator, [...budget(300_000, price), ...ixs], bh.blockhash, alt);
    if (!tx) throw new Error("Couldn't finish the launch. Try again.");
    o.onStep?.("Setting the fee split…");
    await sendAndConfirm(await signAll(tx, signer, []), bh.lastValidBlockHeight, o.onStep);
  }
  if (!o.buyLamports || !o.buyLamports.gtn(0)) return { bought: true };
  try {
    o.onStep?.("Making your first buy…");
    const sdk = new OnlinePumpSdk(c);
    const [global, feeConfig, st] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null), sdk.fetchBuyState(mint, creator, TOKEN_2022)]);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: st.bondingCurve.tokenTotalSupply,
      bondingCurve: st.bondingCurve,
      amount: o.buyLamports,
      quoteMint: st.bondingCurve.quoteMint,
    });
    if (amount.lten(0)) return { bought: false };
    const buy = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      associatedUserAccountInfo: st.associatedUserAccountInfo,
      mint,
      user: creator,
      amount,
      solAmount: o.buyLamports,
      slippage: 1,
      tokenProgram: TOKEN_2022,
    });
    const bh = await c.getLatestBlockhash("confirmed");
    const tx = compile(creator, [...budget(200_000, price), ...buy], bh.blockhash, alt);
    if (!tx) return { bought: false };
    await sendAndConfirm(await signAll(tx, signer, []), bh.lastValidBlockHeight, o.onStep);
    return { bought: true };
  } catch (e) {
    console.warn("sasa: first buy on Solana didn't go through:", e);
    return { bought: false };
  }
}

/** A short reason from a failed check. */
function simError(err: unknown, logs: string[] | null): string {
  const text = JSON.stringify(err) + " " + (logs ?? []).join(" ");
  if (/insufficient (lamports|funds)|0x1\b/i.test(text)) return "Not enough SOL arrived yet. Try again in a moment.";
  return `The launch check failed: ${text.slice(0, 140)}`;
}

/** Tells sasa about the coin (before it's signed; the keeper checks it on chain before listing it). */
export async function recordCoin(r: { mint: string; creator: string; uri: string; sig: string; name: string; symbol: string; image: string }, token?: string | null): Promise<void> {
  for (let i = 0; ; i++) {
    const res = await fetch("/api/sol/coin", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(r),
    }).catch(() => null);
    if (res?.ok) return;
    // signed-in token gone stale: record without it
    if (res?.status === 401) token = null;
    if (i >= 2) throw new Error("Couldn't reach sasa. Nothing was launched: try again in a moment.");
    await new Promise((x) => setTimeout(x, 1000));
  }
}


// ------------------------------------------------------------------ trading on the launch curve

/**
 * Buying and selling a coin that is still on its launch curve (every coin launched on sasa,
 * until it fills up and moves to its pool), straight on the curve with SOL: no route in
 * between, so nothing on the way can refuse it. sasa's trade box uses these first and falls
 * back to a Relay route once the curve is complete (or for other coins).
 */
async function curveState(mint: PublicKey, user: PublicKey) {
  const sdk = new OnlinePumpSdk(solConnection());
  const [global, feeConfig, st] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null), sdk.fetchBuyState(mint, user, TOKEN_2022)]);
  return { global, feeConfig, st };
}

/** true while `mint` trades on its launch curve (false when it has moved on, or isn't a curve coin). */
export async function onCurve(mint: string): Promise<boolean> {
  try {
    const sdk = new OnlinePumpSdk(solConnection());
    const st = await sdk.fetchSellState(new PublicKey(mint), PublicKey.default, TOKEN_2022);
    return !st.bondingCurve.complete && st.bondingCurve.quoteMint !== undefined;
  } catch {
    return false;
  }
}

/** Sells `amount` (raw) of `mint` on its curve for SOL into the same wallet; returns the SOL (lamports) expected. */
export async function curveSell(signer: SolSigner, mint: string, amount: bigint, onStep?: (m: string) => void): Promise<bigint> {
  const c = solConnection();
  const user = new PublicKey(signer.address);
  const m = new PublicKey(mint);
  const { global, feeConfig, st } = await curveState(m, user);
  if (st.bondingCurve.complete) throw new Error("This coin has moved to its pool. Try again.");
  const tokens = new BN(amount.toString());
  const sol = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: tokens, quoteTransferFee: st.quoteTransferFee });
  if (sol.lten(0)) throw new Error("That amount is too small to sell.");
  const ixs = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo: st.bondingCurveAccountInfo,
    bondingCurve: st.bondingCurve,
    mint: m,
    user,
    amount: tokens,
    solAmount: sol,
    slippage: 3,
    tokenProgram: TOKEN_2022,
    mayhemMode: st.bondingCurve.isMayhemMode,
  });
  const [price, bh] = await Promise.all([priorityFee(), c.getLatestBlockhash("confirmed")]);
  const tx = compile(user, [...budget(200_000, price), ...ixs], bh.blockhash, null);
  if (!tx) throw new Error("Couldn't build the sale. Try again.");
  onStep?.("Selling…");
  await sendAndConfirm(await signAll(tx, signer, []), bh.lastValidBlockHeight, onStep);
  return BigInt(sol.toString());
}

/** Buys `mint` on its curve with `lamports` of the wallet's SOL. */
export async function curveBuy(signer: SolSigner, mint: string, lamports: bigint, onStep?: (m: string) => void): Promise<void> {
  const c = solConnection();
  const user = new PublicKey(signer.address);
  const m = new PublicKey(mint);
  const { global, feeConfig, st } = await curveState(m, user);
  if (st.bondingCurve.complete) throw new Error("This coin has moved to its pool. Try again.");
  const solAmount = new BN(lamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: st.bondingCurve.tokenTotalSupply,
    bondingCurve: st.bondingCurve,
    amount: solAmount,
    quoteMint: st.bondingCurve.quoteMint,
  });
  if (amount.lten(0)) throw new Error("That amount is too small to buy.");
  const ixs = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: st.bondingCurveAccountInfo,
    bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo,
    mint: m,
    user,
    amount,
    solAmount,
    slippage: 3,
    tokenProgram: TOKEN_2022,
  });
  const [price, bh] = await Promise.all([priorityFee(), c.getLatestBlockhash("confirmed")]);
  const tx = compile(user, [...budget(250_000, price), ...ixs], bh.blockhash, null);
  if (!tx) throw new Error("Couldn't build the buy. Try again.");
  onStep?.("Buying…");
  await sendAndConfirm(await signAll(tx, signer, []), bh.lastValidBlockHeight, onStep);
}
