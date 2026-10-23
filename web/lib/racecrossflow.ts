import { formatUnits, keccak256, maxUint256, parseUnits, toHex, type Address, type Chain, type Hex, type LocalAccount } from "viem";
import { raceClient, raceErc20Abi, raceFactoryAbi, withGas, type RaceChain } from "./race";
import {
  GAS_ASK_CENTS,
  acrossQuote,
  addPending,
  buyMessage,
  convertDecimals,
  depositCalls,
  gasTopUp,
  launchMessage,
  quoteBuyCoins,
  raceCrossAbi,
  signLaunch,
  usdDecimals,
  type LaunchParams,
} from "./racecross";
import { call, type Call } from "./tx";

/**
 * The steps of a sasa account's trade or launch on a race chain other than Base (see
 * lib/racecross.ts). Pure flows: the wallet's two senders are passed in, so the trade box,
 * the launch page and the tests all run the same code.
 */

export type Senders = {
  user: Address;
  /** Base: one bundle, network fee in USDC (wallet.send). */
  sendHome: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  /** Other chains: plain transactions, gas in that chain's coin (wallet.sendOwnGas). */
  sendThere: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
};

const now = () => Math.floor(Date.now() / 1000);
/** Room left for the network fee on Base, which is paid in USDC from the same balance. */
export const HOME_FEE_ROOM_CENTS = 5;
/** A launch is one big bundle (approve, launch, an Across deposit per other chain): its network
 * fee, paid in USDC, can reach a few dimes, so it keeps more room than a single trade. */
export const LAUNCH_FEE_ROOM_CENTS = 60;
/** Across's fee is quoted for one moment; a little more keeps relayers interested on the way back. */
const FEE_BUFFER_PCT = 20n;

const usd = (v: bigint, dec: number) => Number(formatUnits(v, dec));
const cents = (n: number, dec: number) => (BigInt(n) * 10n ** BigInt(dec)) / 100n;

async function homeBalance(home: RaceChain, user: Address): Promise<bigint> {
  return (await raceClient(home).readContract({ address: home.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [user] })) as bigint;
}

function roomCheck(have: bigint, spend: bigint, dec: number, roomCents = HOME_FEE_ROOM_CENTS) {
  const room = cents(roomCents, dec);
  if (spend + room > have) {
    const max = have > room ? have - room : 0n;
    throw new Error(
      roomCents > HOME_FEE_ROOM_CENTS
        ? `Not enough USDC on Base: this launch needs $${usd(spend + room, dec).toFixed(2)} (with the network fee), you have $${usd(have, dec).toFixed(2)}. Lower the first buy or add money with the + button.`
        : `Not enough USDC. You can use up to $${usd(max, dec).toFixed(2)} (a few cents stay for the network fee).`
    );
  }
}

// ------------------------------------------------------------------ buy

export type CrossBuyResult = { tx: Hex; coinsExpected: bigint; feeUsd: number; gasUsd: number; usdIn: number };

/** Buys `coin` on `dest` with `amountHome` of the user's Base dollars. */
export async function crossBuy(o: {
  s: Senders;
  home: RaceChain;
  dest: RaceChain;
  coin: Address;
  priceUsd: number | null;
  amountHome: bigint;
  slipBps: bigint;
  onStep?: (m: string) => void;
}): Promise<CrossBuyResult> {
  const { s, home, dest, coin } = o;
  if (!dest.cross) throw new Error(`${dest.short} isn't open to sasa accounts yet.`);
  const [homeDec, destDec] = await Promise.all([usdDecimals(home), usdDecimals(dest)]);
  o.onStep?.("Checking your balance…");
  roomCheck(await homeBalance(home, s.user), o.amountHome, homeDec);

  o.onStep?.("Getting the price…");
  const deadline = BigInt(now() + 30 * 60);
  const ask = cents(GAS_ASK_CENTS, destDec);
  // the fee depends on the delivery's gas, so it's asked with an order of the real shape
  const probe = buyMessage({ user: s.user, coin, minCoinsOut: 1n, gasUsd: ask, deadline });
  const q0 = await acrossQuote({ from: home, to: dest, amount: o.amountHome, recipient: dest.cross, message: probe });
  if (q0.tooLow || q0.fee >= o.amountHome) throw new Error("That amount is too small to send to another chain. Try a bit more.");
  if (q0.maxDeposit !== null && o.amountHome > q0.maxDeposit) throw new Error(`Across takes at most $${usd(q0.maxDeposit, homeDec).toFixed(0)} at once right now.`);
  const arriving = convertDecimals(o.amountHome - q0.fee, homeDec, destDec);
  const gas = await gasTopUp(dest, s.user, arriving);
  const buyWith = arriving - gas;
  // the exact amount from a dry run of the real buy; without it the minimum would be a guess,
  // and a guess too high turns the buy into a refund on the other chain
  const coins = await quoteBuyCoins(dest, s.user, coin, buyWith);
  if (coins === null) throw new Error(`Couldn't price this buy on ${dest.short} right now. Try again in a moment.`);
  if (coins === 0n) throw new Error("This trade would give nothing back. Try a bigger amount.");
  const minCoinsOut = (coins * (10_000n - o.slipBps)) / 10_000n;
  const message = buyMessage({ user: s.user, coin, minCoinsOut, gasUsd: gas > 0n ? ask : 0n, deadline });
  const q = await acrossQuote({ from: home, to: dest, amount: o.amountHome, recipient: dest.cross, message });
  const dep = depositCalls(home, dest, s.user, o.amountHome, homeDec, destDec, q, message, 30 * 60);

  const tx = await sendKeepingTrack(() => s.sendHome(home.chain, dep.calls, o.onStep), (tx) =>
    addPending({ kind: "buy", originChainId: home.chainId, tx, usd: usd(o.amountHome, homeDec), chainId: dest.chainId, coin })
  );
  return { tx, coinsExpected: coins, feeUsd: usd(q.fee, homeDec), gasUsd: usd(gas, destDec), usdIn: usd(o.amountHome, homeDec) };
}

// ------------------------------------------------------------------ sell and send home

/** Gas a sale there takes at most (approval ~50k, sell + the deposit home ~300k). */
const APPROVE_GAS = 60_000n;
const SELL_HOME_GAS = 300_000n;

/** Refuses up front when the account's gas coin there can't pay for the steps (rather than a send that never lands). */
async function needGasThere(dest: RaceChain, user: Address, gas: bigint = SELL_HOME_GAS) {
  const pub = raceClient(dest);
  const sym = dest.chain.nativeCurrency.symbol;
  const [bal, price] = await Promise.all([pub.getBalance({ address: user }), pub.getGasPrice().catch(() => 0n)]);
  if (bal === 0n) throw new Error(`No ${sym} on ${dest.short} for the network fee. Any buy there brings a little with it.`);
  if (price > 0n && bal < price * gas) {
    const need = Number(formatUnits(price * gas, 18));
    throw new Error(`Not enough ${sym} on ${dest.short} for the network fee (about ${need.toPrecision(2)} ${sym} needed). Any buy there brings a little with it.`);
  }
}

async function allowanceOf(dest: RaceChain, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await raceClient(dest).readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [owner, spender] }).catch(() => 0n)) as bigint;
}

async function approveThere(s: Senders, dest: RaceChain, token: Address, spender: Address, amount: bigint, onStep?: (m: string) => void) {
  if ((await allowanceOf(dest, token, s.user, spender)) >= amount) return;
  try {
    await s.sendThere(dest.chain, [call(token, raceErc20Abi, "approve", [spender, maxUint256])], (m) => onStep?.(`Approve: ${m}`));
  } catch (e) {
    // sent, but the receipt didn't show up in time: what matters is the allowance, so look at that
    if (!String((e as Error)?.message ?? "").includes("SENT_UNCONFIRMED")) throw e;
    onStep?.(`Approve: waiting for ${dest.short}…`);
    for (let i = 0; i < 45; i++) {
      if ((await allowanceOf(dest, token, s.user, spender)) >= amount) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${dest.short} hasn't confirmed the approval yet. Try again in a minute.`);
  }
  // the node answering next may be a block behind the approval
  for (let i = 0; i < 8; i++) {
    if ((await allowanceOf(dest, token, s.user, spender)) >= amount) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Across's fee to bring `amount` (dest units) home, with a buffer, in dest units. */
async function homeFee(dest: RaceChain, home: RaceChain, user: Address, amount: bigint): Promise<bigint> {
  const q = await acrossQuote({ from: dest, to: home, amount, recipient: user });
  // a deposit Across won't take would sit for hours before coming back: refuse it here
  if (q.tooLow) throw new Error("That's too little to send back to Base. Try a bigger amount.");
  if (q.maxDeposit !== null && amount > q.maxDeposit) {
    const dec = await usdDecimals(dest);
    throw new Error(`Across takes at most $${usd(q.maxDeposit, dec).toFixed(0)} at once right now. Sell in smaller parts.`);
  }
  return (q.fee * (100n + FEE_BUFFER_PCT)) / 100n + 1n;
}

/** Sends, then records the deposit as "on its way". (An unconfirmed send throws SENT_UNCONFIRMED, which the trade box shows as "sent, check before trying again".) */
async function sendKeepingTrack(send: () => Promise<Hex>, track: (tx: Hex) => void): Promise<Hex> {
  const tx = await send();
  track(tx);
  return tx;
}

export type CrossSellResult = { tx: Hex; usdOut: number; feeUsd: number };

/** Sells `coinsIn` of `coin` on `dest`; the dollars go back to the user's address on Base. */
export async function crossSell(o: {
  s: Senders;
  home: RaceChain;
  dest: RaceChain;
  coin: Address;
  coinsIn: bigint;
  slipBps: bigint;
  /** The dollars the sale should bring (dest units, from the last price): Across's fee is asked for while the approval runs. */
  estOut?: bigint;
  onStep?: (m: string) => void;
}): Promise<CrossSellResult> {
  const { s, home, dest, coin } = o;
  if (!dest.cross) throw new Error(`${dest.short} isn't open to sasa accounts yet.`);
  const pub = raceClient(dest);
  const destDec = await usdDecimals(dest);
  const approved = (await allowanceOf(dest, coin, s.user, dest.cross)) >= o.coinsIn;
  await needGasThere(dest, s.user, SELL_HOME_GAS + (approved ? 0n : APPROVE_GAS));
  const early = o.estOut && o.estOut > 0n ? homeFee(dest, home, s.user, o.estOut).catch(() => null) : Promise.resolve(null);
  if (!approved) await approveThere(s, dest, coin, dest.cross, o.coinsIn, o.onStep);

  o.onStep?.("Getting the price…");
  const deadline = BigInt(now() + 600);
  const sim = await pub.simulateContract({
    account: s.user,
    address: dest.cross,
    abi: raceCrossAbi,
    functionName: "sellAndSendHome",
    args: [coin, o.coinsIn, 0n, 0n, deadline],
  });
  const out = sim.result as bigint;
  const minOut = (out * (10_000n - o.slipBps)) / 10_000n;
  // the fee asked for early holds while the sale is within 15% of the estimate (it has a 20% buffer)
  const pre = await early;
  const close = !!o.estOut && out * 100n >= o.estOut * 85n && out * 100n <= o.estOut * 115n;
  const fee = pre !== null && close ? pre : await homeFee(dest, home, s.user, out);
  if (fee >= minOut) throw new Error("That's too little to send back to Base. Sell a bit more.");

  const trade = await withGas(pub, s.user, call(dest.cross, raceCrossAbi, "sellAndSendHome", [coin, o.coinsIn, minOut, fee, deadline]));
  const tx = await s.sendThere(dest.chain, [trade], o.onStep);
  const back = usd(out - fee, destDec);
  addPending({ kind: "home", originChainId: dest.chainId, tx, usd: back, chainId: home.chainId });
  return { tx, usdOut: back, feeUsd: usd(fee, destDec) };
}

/** Dollars on `dest` that can go home: on Arc the dollar is also the gas, so some stays. */
export async function spareThere(dest: RaceChain, user: Address): Promise<bigint> {
  const pub = raceClient(dest);
  const [bal, dec] = await Promise.all([
    pub.readContract({ address: dest.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [user] }) as Promise<bigint>,
    usdDecimals(dest),
  ]);
  const keep = dest.chain.nativeCurrency.symbol === "USDC" ? cents(GAS_ASK_CENTS, dec) : 0n;
  return bal > keep ? bal - keep : 0n;
}

/** Sends `amount` (dest units) of the user's dollars on `dest` back to Base. */
export async function crossSendHome(o: { s: Senders; home: RaceChain; dest: RaceChain; amount: bigint; onStep?: (m: string) => void; maxFeeBps?: number }): Promise<CrossSellResult> {
  const { s, home, dest } = o;
  if (!dest.cross) throw new Error(`${dest.short} isn't open to sasa accounts yet.`);
  const pub = raceClient(dest);
  const destDec = await usdDecimals(dest);
  await needGasThere(dest, s.user);
  o.onStep?.("Getting the fee…");
  const fee = await homeFee(dest, home, s.user, o.amount);
  if (fee >= o.amount) throw new Error("That's too little to send back to Base.");
  // a caller moving money on its own (not asked by the user) only moves it when the fee is small
  if (o.maxFeeBps !== undefined && fee * 10_000n > o.amount * BigInt(o.maxFeeBps)) throw new Error("The fee is too big a share of this amount; it waits for more.");
  await approveThere(s, dest, dest.usd, dest.cross, o.amount, o.onStep);
  const move = await withGas(pub, s.user, call(dest.cross, raceCrossAbi, "sendHome", [o.amount, fee]));
  const tx = await s.sendThere(dest.chain, [move], o.onStep);
  const back = usd(o.amount - fee, destDec);
  addPending({ kind: "home", originChainId: dest.chainId, tx, usd: back, chainId: home.chainId });
  return { tx, usdOut: back, feeUsd: usd(fee, destDec) };
}

// ------------------------------------------------------------------ launch

export type LaunchDraft = {
  key: Hex;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  feeMode: 0 | 1;
  chains: number[];
  /** Each chain's first buy, in dollars ("2.50"). */
  firstBuy: string;
  /** Chains already sent through Across: unix time until which the delivery may still land. */
  sent?: Record<number, number>;
};

export type LaunchPlan = {
  calls: Call[];
  /** Base dollars the whole launch takes (first buys, race fees, Across fees, gas top-ups). */
  totalHome: bigint;
  /** Chains this launch sends through Across, and until when each may land. */
  crossUntil: Record<number, number>;
  homeLaunch: boolean;
};

/** Longest message sent inside Across's price request (hex characters). */
const QUOTE_MESSAGE_MAX = 6_000;

/**
 * How long the user's launch signature stays good. Deliveries normally land in seconds; the
 * long window only matters when the Base bundle itself waits before it's mined, so the
 * deliveries still go through instead of coming back. (Each delivery also has its own
 * window counted from the block the deposit lands in, see depositCalls.)
 */
export const LAUNCH_WINDOW_S = 60 * 60;
/** Stands in for a signature when only the message length matters. */
const SIG_SHAPE = `0x${"11".repeat(65)}` as Hex;
/** Room for the Base bundle to be mined, on top of a delivery's own window. */
const MINE_ROOM_S = 5 * 60;

/** One cross chain's part of a launch: its Base calls and what it costs there. */
type CrossPart = { chainId: number; calls: Call[]; amount: bigint; until: number };

/**
 * The single Base bundle that launches `d` on every chain where it isn't live yet: directly
 * on Base, and through Across + RaceCross (with the user's signature) everywhere else.
 * Every chain is prepared at the same time.
 */
export async function planLaunch(o: {
  user: Address;
  signer: LocalAccount;
  home: RaceChain;
  picked: RaceChain[];
  d: LaunchDraft;
  live: Set<number>;
  onStep?: (m: string) => void;
}): Promise<LaunchPlan> {
  const { user, home, d } = o;
  const eids = o.picked.map((c) => c.eid).sort((a, b) => a - b);
  const params = (dec: number): LaunchParams => ({
    name: d.name,
    symbol: d.symbol,
    logo: d.logo,
    description: d.description,
    launchKey: d.key,
    eids,
    feeMode: d.feeMode,
    firstBuy: parseUnits(d.firstBuy, dec),
    minCoinsOut: 0n,
  });
  const until = now() + LAUNCH_WINDOW_S;

  const homePart = async (): Promise<{ calls: Call[]; amount: bigint } | null> => {
    if (!o.picked.some((c) => c.chainId === home.chainId) || o.live.has(home.chainId)) return null;
    const [homeDec, fee] = await Promise.all([
      usdDecimals(home),
      raceClient(home).readContract({ address: home.factory, abi: raceFactoryAbi, functionName: "raceFee" }) as Promise<bigint>,
    ]);
    const l = params(homeDec);
    const spend = l.firstBuy + fee;
    return {
      calls: [call(home.usd, raceErc20Abi, "approve", [home.factory, spend]), call(home.factory, raceFactoryAbi as never, "launch", [l])],
      amount: spend,
    };
  };

  const crossPart = async (c: RaceChain): Promise<CrossPart | null> => {
    if (c.chainId === home.chainId || o.live.has(c.chainId)) return null;
    // still on its way from an earlier try: don't send it twice
    if (d.sent?.[c.chainId] && d.sent[c.chainId] > now()) return null;
    if (!c.cross) throw new Error(`${c.short} isn't open to sasa accounts yet. Untick it.`);
    const pub = raceClient(c);
    const [homeDec, dec, fee, open] = await Promise.all([
      usdDecimals(home),
      usdDecimals(c),
      pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "raceFee" }) as Promise<bigint>,
      pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "launchesOpen" }) as Promise<boolean>,
    ]);
    if (!open) throw new Error(`Launches are paused on ${c.short}.`);
    const l = params(dec);
    const ask = cents(GAS_ASK_CENTS, dec);
    const gas = (await gasTopUp(c, user, l.firstBuy * 4n)) > 0n ? ask : 0n;
    // what must arrive there, plus 1% so a slightly lower fill still covers it (the rest comes back as change)
    const need = ((l.firstBuy + fee + gas) * 101n) / 100n;
    const needHome = convertDecimals(need, dec, homeDec) + 1n;
    // A picture makes the message too long to send in Across's price request (a web address):
    // the price is asked without it, plus a margin for delivering the extra bytes. Across
    // dry-runs the delivery, signature check included, so the shorter stand-in carries its own
    // signature. It launches a different coin (a throwaway key) and is never deposited.
    // (a signature is always 65 bytes, so the length is known before signing)
    const long = launchMessage({ user, launch: l, gasUsd: gas, deadline: BigInt(until), signature: SIG_SHAPE }).length > QUOTE_MESSAGE_MAX;
    const stand = { ...l, logo: "", launchKey: keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))) };
    const [sig, standSig] = await Promise.all([
      signLaunch(o.signer, c, l, gas, BigInt(until)),
      long ? signLaunch(o.signer, c, stand, gas, BigInt(until)) : Promise.resolve(null),
    ]);
    const message = launchMessage({ user, launch: l, gasUsd: gas, deadline: BigInt(until), signature: sig });
    const probe = long && standSig ? launchMessage({ user, launch: stand, gasUsd: gas, deadline: BigInt(until), signature: standSig }) : message;
    const margin = (fee0: bigint) => (long ? fee0 / 4n + cents(10, homeDec) : 0n);
    const q0 = await acrossQuote({ from: home, to: c, amount: needHome, recipient: c.cross, message: probe });
    // the fee on top, asked again for the final amount (the fee moves a little with the amount)
    const amount = needHome + ((q0.fee + margin(q0.fee)) * 105n) / 100n + 1n;
    const q1 = await acrossQuote({ from: home, to: c, amount, recipient: c.cross, message: probe });
    if (q1.tooLow) throw new Error(`Across won't take this amount to ${c.short}. Raise the first buy.`);
    const q = { ...q1, fee: q1.fee + margin(q1.fee) };
    const dep = depositCalls(home, c, user, amount, homeDec, dec, q, message);
    if (dep.outputAmount < l.firstBuy + fee + gas) throw new Error("Across's fee moved. Try again.");
    return { chainId: c.chainId, calls: dep.calls, amount, until: dep.fillDeadline + MINE_ROOM_S };
  };

  o.onStep?.("Preparing…");
  const [hp, ...parts] = await Promise.all([homePart(), ...o.picked.map((c) => crossPart(c))]);
  const calls: Call[] = [];
  let totalHome = 0n;
  const crossUntil: Record<number, number> = {};
  if (hp) {
    calls.push(...hp.calls);
    totalHome += hp.amount;
  }
  for (const p of parts) {
    if (!p) continue;
    calls.push(...p.calls);
    totalHome += p.amount;
    crossUntil[p.chainId] = p.until;
  }
  return { calls, totalHome, crossUntil, homeLaunch: !!hp };
}

/** Sends the plan (one Base bundle) after checking the balance; returns the transaction. */
export async function sendLaunch(o: { s: Senders; home: RaceChain; plan: LaunchPlan; onStep?: (m: string) => void }): Promise<Hex> {
  const homeDec = await usdDecimals(o.home);
  roomCheck(await homeBalance(o.home, o.s.user), o.plan.totalHome, homeDec, LAUNCH_FEE_ROOM_CENTS);
  return o.s.sendHome(o.home.chain, o.plan.calls, o.onStep);
}

/** True once the coin is live on `c`. */
export async function liveOn(c: RaceChain, creator: Address, key: Hex): Promise<boolean> {
  const pub = raceClient(c);
  const coin = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "coinAddress", args: [creator, key] })) as Address;
  const code = await pub.getCode({ address: coin });
  return !!code && code.length > 2;
}

export { usd as unitsToUsd };
