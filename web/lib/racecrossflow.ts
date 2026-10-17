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
/** Across's fee is quoted for one moment; a little more keeps relayers interested on the way back. */
const FEE_BUFFER_PCT = 20n;

const usd = (v: bigint, dec: number) => Number(formatUnits(v, dec));
const cents = (n: number, dec: number) => (BigInt(n) * 10n ** BigInt(dec)) / 100n;

async function homeBalance(home: RaceChain, user: Address): Promise<bigint> {
  return (await raceClient(home).readContract({ address: home.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [user] })) as bigint;
}

function roomCheck(have: bigint, spend: bigint, dec: number) {
  if (spend + cents(HOME_FEE_ROOM_CENTS, dec) > have) {
    const max = have > cents(HOME_FEE_ROOM_CENTS, dec) ? have - cents(HOME_FEE_ROOM_CENTS, dec) : 0n;
    throw new Error(`Not enough USDC. You can use up to $${usd(max, dec).toFixed(2)} (a few cents stay for the network fee).`);
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
  const dep = depositCalls(home, dest, s.user, o.amountHome, homeDec, destDec, q, message, Number(deadline));

  const tx = await sendKeepingTrack(() => s.sendHome(home.chain, dep.calls, o.onStep), (tx) =>
    addPending({ kind: "buy", originChainId: home.chainId, tx, usd: usd(o.amountHome, homeDec), chainId: dest.chainId, coin })
  );
  return { tx, coinsExpected: coins, feeUsd: usd(q.fee, homeDec), gasUsd: usd(gas, destDec), usdIn: usd(o.amountHome, homeDec) };
}

// ------------------------------------------------------------------ sell and send home

async function needGasThere(dest: RaceChain, user: Address) {
  const bal = await raceClient(dest).getBalance({ address: user });
  if (bal === 0n) {
    throw new Error(`No ${dest.chain.nativeCurrency.symbol} on ${dest.short} for the network fee. Any buy there brings a little with it.`);
  }
}

async function approveThere(s: Senders, dest: RaceChain, token: Address, spender: Address, amount: bigint, onStep?: (m: string) => void) {
  const pub = raceClient(dest);
  const a = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [s.user, spender] })) as bigint;
  if (a >= amount) return;
  await s.sendThere(dest.chain, [call(token, raceErc20Abi, "approve", [spender, maxUint256])], (m) => onStep?.(`Approve: ${m}`));
  // the node answering next may be a block behind the approval
  for (let i = 0; i < 8; i++) {
    const b = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [s.user, spender] }).catch(() => 0n)) as bigint;
    if (b >= amount) return;
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
  onStep?: (m: string) => void;
}): Promise<CrossSellResult> {
  const { s, home, dest, coin } = o;
  if (!dest.cross) throw new Error(`${dest.short} isn't open to sasa accounts yet.`);
  const pub = raceClient(dest);
  const destDec = await usdDecimals(dest);
  await needGasThere(dest, s.user);
  await approveThere(s, dest, coin, dest.cross, o.coinsIn, o.onStep);

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
  const fee = await homeFee(dest, home, s.user, out);
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
export async function crossSendHome(o: { s: Senders; home: RaceChain; dest: RaceChain; amount: bigint; onStep?: (m: string) => void }): Promise<CrossSellResult> {
  const { s, home, dest } = o;
  if (!dest.cross) throw new Error(`${dest.short} isn't open to sasa accounts yet.`);
  const pub = raceClient(dest);
  const destDec = await usdDecimals(dest);
  await needGasThere(dest, s.user);
  o.onStep?.("Getting the fee…");
  const fee = await homeFee(dest, home, s.user, o.amount);
  if (fee >= o.amount) throw new Error("That's too little to send back to Base.");
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

/** Cross launches must land within this; after it Across returns the dollars to Base. */
export const LAUNCH_WINDOW_S = 15 * 60;

/**
 * The single Base bundle that launches `d` on every chain where it isn't live yet: directly
 * on Base, and through Across + RaceCross (with the user's signature) everywhere else.
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
  const homeDec = await usdDecimals(home);
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
  const calls: Call[] = [];
  let totalHome = 0n;
  const crossUntil: Record<number, number> = {};
  let homeLaunch = false;

  if (o.picked.some((c) => c.chainId === home.chainId) && !o.live.has(home.chainId)) {
    const fee = (await raceClient(home).readContract({ address: home.factory, abi: raceFactoryAbi, functionName: "raceFee" })) as bigint;
    const l = params(homeDec);
    const spend = l.firstBuy + fee;
    calls.push(call(home.usd, raceErc20Abi, "approve", [home.factory, spend]));
    calls.push(call(home.factory, raceFactoryAbi as never, "launch", [l]));
    totalHome += spend;
    homeLaunch = true;
  }

  const until = now() + LAUNCH_WINDOW_S;
  for (const c of o.picked) {
    if (c.chainId === home.chainId || o.live.has(c.chainId)) continue;
    // still on its way from an earlier try: don't send it twice
    if (d.sent?.[c.chainId] && d.sent[c.chainId] > now()) continue;
    if (!c.cross) throw new Error(`${c.short} isn't open to sasa accounts yet. Untick it.`);
    o.onStep?.(`Preparing ${c.short}…`);
    const dec = await usdDecimals(c);
    const pub = raceClient(c);
    const [fee, open] = await Promise.all([
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
    const sig = await signLaunch(o.signer, c, l, gas, BigInt(until));
    const message = launchMessage({ user, launch: l, gasUsd: gas, deadline: BigInt(until), signature: sig });
    // A picture makes the message too long to send in Across's price request (a web address):
    // the price is asked without it, plus a margin for delivering the extra bytes.
    const long = message.length > QUOTE_MESSAGE_MAX;
    // Across dry-runs the delivery, signature check included, so the shorter stand-in carries its
    // own signature. It launches a different coin (a throwaway key) and is never deposited.
    let probe = message;
    if (long) {
      const stand = { ...l, logo: "", launchKey: keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))) };
      const standSig = await signLaunch(o.signer, c, stand, gas, BigInt(until));
      probe = launchMessage({ user, launch: stand, gasUsd: gas, deadline: BigInt(until), signature: standSig });
    }
    const margin = (fee0: bigint) => (long ? fee0 / 4n + cents(10, homeDec) : 0n);
    const q0 = await acrossQuote({ from: home, to: c, amount: needHome, recipient: c.cross, message: probe });
    // the fee on top, asked again for the final amount (the fee moves a little with the amount)
    const amount = needHome + ((q0.fee + margin(q0.fee)) * 105n) / 100n + 1n;
    const q1 = await acrossQuote({ from: home, to: c, amount, recipient: c.cross, message: probe });
    if (q1.tooLow) throw new Error(`Across won't take this amount to ${c.short}. Raise the first buy.`);
    const q = { ...q1, fee: q1.fee + margin(q1.fee) };
    const dep = depositCalls(home, c, user, amount, homeDec, dec, q, message, until);
    if (dep.outputAmount < l.firstBuy + fee + gas) throw new Error("Across's fee moved. Try again.");
    calls.push(...dep.calls);
    totalHome += amount;
    crossUntil[c.chainId] = dep.fillDeadline;
  }
  return { calls, totalHome, crossUntil, homeLaunch };
}

/** Sends the plan (one Base bundle) after checking the balance; returns the transaction. */
export async function sendLaunch(o: { s: Senders; home: RaceChain; plan: LaunchPlan; onStep?: (m: string) => void }): Promise<Hex> {
  const homeDec = await usdDecimals(o.home);
  roomCheck(await homeBalance(o.home, o.s.user), o.plan.totalHome, homeDec);
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
