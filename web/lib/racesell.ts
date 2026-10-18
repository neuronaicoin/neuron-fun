import { formatUnits, maxUint256, type Address, type Hex } from "viem";
import { raceClient, raceErc20Abi, raceRouterAbi, withGas, type RaceChain, type RaceCoin, type RaceLane } from "./race";
import { usdDecimals } from "./racecross";
import { crossSell, type Senders } from "./racecrossflow";
import { call, type Call } from "./tx";
import { friendlyError } from "./format";

/**
 * One "Sell" for a race coin, whatever chains the coins are on: the user never picks a chain.
 *  - While the race runs: every open chain where the account holds coins sells its share, all at once.
 *  - Once it's decided: only the winner sells. Coins on a losing chain are being moved to the
 *    winner by the keeper, so they're shown as "on the way" and sold with the next tap.
 * A sasa account's dollars all end up on Base (other chains through Across); a browser wallet
 * sells chain by chain, one confirmation each, and keeps the dollars on each chain.
 */

export type LegState = "ready" | "selling" | "done" | "failed" | "moving" | "closed";
export type SellLeg = {
  chain: RaceChain;
  lane: RaceLane;
  coins: bigint;
  state: LegState;
  step?: string;
  usd?: number;
  tx?: Hex;
  error?: string;
  /** why a "closed" leg isn't sold */
  note?: string;
};

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

/** The chains to sell on now, from the race's state (lanes the indexer marks lost are skipped too). */
export function sellLanes(coin: RaceCoin): RaceLane[] {
  if (coin.winner) return coin.lanes.filter((l) => l.chain.chainId === coin.winner!.chainId);
  return coin.lanes.filter((l) => l.state !== 3);
}

/** The account's coins on every chain of the race (a chain that can't be read counts as none for now). */
/** Below this, coins on a chain other than Base aren't worth Across's fee to bring home. */
export const MIN_AWAY_USD = 1;

export async function readLegs(coin: RaceCoin, user: Address, canSell: (c: RaceChain) => boolean, homeChainId: number | null = null): Promise<SellLeg[]> {
  const open = new Set(sellLanes(coin).map((l) => l.chain.chainId));
  const legs = await Promise.all(
    coin.lanes.map(async (lane): Promise<SellLeg> => {
      const coins = (await raceClient(lane.chain)
        .readContract({ address: coin.coin, abi: raceErc20Abi, functionName: "balanceOf", args: [user] })
        .catch(() => 0n)) as bigint;
      let state: LegState = !open.has(lane.chain.chainId) ? "moving" : canSell(lane.chain) ? "ready" : "closed";
      let note: string | undefined = state === "closed" ? "not open to email accounts yet" : undefined;
      const usd = lane.priceUsd ? Number(formatUnits(coins, 18)) * lane.priceUsd : null;
      // dollars sold away from Base travel home through Across: a few cents can't pay its fee
      if (state === "ready" && homeChainId !== null && lane.chain.chainId !== homeChainId && usd !== null && usd < MIN_AWAY_USD) {
        state = "closed";
        note = "too little to bring back to Base";
      }
      return { chain: lane.chain, lane, coins, state, note, usd: usd ?? undefined };
    })
  );
  // dust (under a cent) isn't shown at all
  return legs.filter((l) => l.coins > 0n && (l.usd === undefined || l.usd >= 0.01));
}

/** `bps` (1..10000) of `coins`; all of it at 10000, so nothing is left behind by rounding. */
export const share = (coins: bigint, bps: bigint) => (bps >= 10_000n ? coins : (coins * bps) / 10_000n);

/** Dollars the sale should bring at the last price (dest units), or 0 when there's no price. */
export async function estimateOut(leg: SellLeg, coins: bigint): Promise<bigint> {
  if (!leg.lane.priceUsd) return 0n;
  const dec = await usdDecimals(leg.chain);
  const usd = Number(formatUnits(coins, 18)) * leg.lane.priceUsd;
  return BigInt(Math.floor(usd * 10 ** Math.min(dec, 9))) * 10n ** BigInt(Math.max(0, dec - 9));
}

/**
 * Sells `coins` through the chain's router to `user` with `send` (approval and sale together when
 * the node can dry-run both at once, which a sasa account on Base sends as one bundle).
 */
export async function routerSell(o: {
  send: (calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  chain: RaceChain;
  user: Address;
  coin: Address;
  coins: bigint;
  slipBps: bigint;
  onStep?: (m: string) => void;
}): Promise<{ tx: Hex; usd: number }> {
  const { chain, user, coin, coins } = o;
  const pub = raceClient(chain);
  const dec = await usdDecimals(chain);
  const allowance = (await pub.readContract({ address: coin, abi: raceErc20Abi, functionName: "allowance", args: [user, chain.router] })) as bigint;
  const approve = allowance < coins ? [call(coin, raceErc20Abi, "approve", [chain.router, maxUint256])] : [];
  const sellCall = (min: bigint) => call(chain.router, raceRouterAbi, "sell", [coin, coins, min, user, deadline()]);
  const minOf = (out: bigint) => {
    if (out === 0n) throw new Error("This sale would give nothing back.");
    return (out * (10_000n - o.slipBps)) / 10_000n;
  };

  o.onStep?.("Getting the price…");
  if (approve.length) {
    // both steps dry-run together: one send instead of two
    let out: bigint | null = null;
    try {
      const sim = await pub.simulateCalls({ account: user, calls: [...approve, sellCall(0n)].map((c) => ({ to: c.to, data: c.data })) });
      const r = sim.results[1] as { status: string; data?: Hex };
      if (r.status === "success" && r.data && r.data.length >= 66) out = BigInt(r.data.slice(0, 66));
      else if (r.status !== "success") throw Object.assign(new Error("The sale can't go through on this chain right now."), { cause: r });
    } catch (e) {
      // a node without eth_simulateV1 says so; anything else is a real refusal
      if ((e as Error)?.message?.startsWith("The sale can't")) throw e;
    }
    if (out !== null) {
      const tx = await o.send([...approve, sellCall(minOf(out))], o.onStep);
      return { tx, usd: Number(formatUnits(out, dec)) };
    }
    await o.send(approve, (m) => o.onStep?.(`Approve: ${m}`));
    for (let i = 0; i < 8; i++) {
      const a = (await pub.readContract({ address: coin, abi: raceErc20Abi, functionName: "allowance", args: [user, chain.router] }).catch(() => 0n)) as bigint;
      if (a >= coins) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    o.onStep?.("Getting the price…");
  }
  const sim = await pub.simulateContract({ account: user, address: chain.router, abi: raceRouterAbi, functionName: "sell", args: [coin, coins, 0n, user, deadline()] });
  const out = sim.result as bigint;
  const trade = await withGas(pub, user, sellCall(minOf(out)));
  const tx = await o.send([trade], o.onStep);
  return { tx, usd: Number(formatUnits(out, dec)) };
}

/**
 * Sells `bps` of the account's coins on every leg that's "ready". A sasa account sells all chains
 * at once (each chain has its own sender); a browser wallet goes one chain at a time, since each
 * needs its own confirmation. `onLeg` reports every change, so the screen can show each chain.
 */
export async function sellEverywhere(o: {
  legs: SellLeg[];
  coin: Address;
  bps: bigint;
  slipBps: bigint;
  /** sasa account: senders for Base and the other chains; null for a browser wallet. */
  s: Senders | null;
  home: RaceChain | null;
  /** browser wallet: plain send on any chain */
  send: (chain: RaceChain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  user: Address;
  onLeg: (chainId: number, patch: Partial<SellLeg>) => void;
}): Promise<SellLeg[]> {
  const out = o.legs.map((l) => ({ ...l }));
  const patch = (i: number, p: Partial<SellLeg>) => {
    Object.assign(out[i], p);
    o.onLeg(out[i].chain.chainId, p);
  };
  const one = async (i: number) => {
    const leg = out[i];
    const coins = share(leg.coins, o.bps);
    if (coins === 0n) return;
    patch(i, { state: "selling", step: "Starting…", error: undefined });
    const onStep = (m: string) => patch(i, { step: m });
    try {
      if (o.s && o.home && leg.chain.chainId !== o.home.chainId) {
        const estOut = await estimateOut(leg, coins).catch(() => 0n);
        const r = await crossSell({ s: o.s, home: o.home, dest: leg.chain, coin: o.coin, coinsIn: coins, slipBps: o.slipBps, estOut, onStep });
        patch(i, { state: "done", usd: r.usdOut, tx: r.tx, step: undefined });
      } else {
        const send = o.s && o.home ? (calls: Call[], st?: (m: string) => void) => o.s!.sendHome(leg.chain.chain, calls, st) : (calls: Call[], st?: (m: string) => void) => o.send(leg.chain, calls, st);
        const r = await routerSell({ send, chain: leg.chain, user: o.user, coin: o.coin, coins, slipBps: o.slipBps, onStep });
        patch(i, { state: "done", usd: r.usd, tx: r.tx, step: undefined });
      }
    } catch (e) {
      patch(i, { state: "failed", error: errorText(e, leg.chain), step: undefined });
    }
  };
  const ready = out.map((l, i) => (l.state === "ready" ? i : -1)).filter((i) => i >= 0);
  if (o.s) await Promise.all(ready.map(one));
  else for (const i of ready) await one(i);
  return out;
}

function errorText(e: unknown, chain: RaceChain): string {
  const raw = String((e as Error)?.message ?? "") + JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  if (/RaceLostPoolShut/.test(raw)) return `${chain.short} lost the race: these coins are moving to the winner.`;
  if (/SENT_UNCONFIRMED/.test(raw)) return `Sent. ${chain.short} is slow to confirm; check your balance in a minute before trying again.`;
  if (/Slippage/.test(raw)) return "The price moved too much. Try again.";
  return friendlyError(e).replace("Not enough ETH", `Not enough ${chain.chain.nativeCurrency.symbol}`);
}
