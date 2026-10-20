"use client";

/**
 * sasa's money in one place (admin page, admin wallet only): what sasa has earned, where it is,
 * and one-tap buttons to bring waiting fees into the treasury. Everything shown is public
 * on-chain data; the buttons only call functions anyone may call (collectFees, distribute),
 * which can only send money to sasa's own fee vault and treasury.
 *
 * How the money moves:
 *   1. every trade pays a pool fee; it waits inside the coin's pool
 *   2. collectFees (after the coin's 5-minute race on that chain): 70% to sasa's fee vault,
 *      30% to the coin's side (its creator, or its buyback)
 *   3. distribute: the vault splits 80% treasury / 10% keeper / 10% rewards
 */
import { useCallback, useEffect, useState } from "react";
import { formatUnits, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { RACE_CHAINS, RACE_SETS, fetchRaceCoins, raceClient, raceErc20Abi, raceExplorerAddress, raceRouterAbi, type RaceChain, type RaceCoin } from "@/lib/race";
import { HL_BUILDER } from "@/lib/config";
import { call, type Call } from "@/lib/tx";
import { friendlyError } from "@/lib/format";

/** sasa's wallets (the same address on every chain). */
const WALLETS: { key: string; name: string; what: string; address: Address; gas?: boolean }[] = [
  { key: "treasury", name: "Treasury", what: "sasa's earnings (80% of every fee)", address: "0x3C4E66b4B4DDD1F6348aD5fDfAE7e60AC35aca6F" },
  { key: "vault", name: "Fee vault", what: "Fees waiting to be split (80% goes to the treasury)", address: "0x230f730aa453397530833d8101aD6f7a07e0950a" },
  { key: "keeper", name: "Keeper", what: "Runs the races; race fees pay its gas", address: "0x9F832eea4f7c246d196d8E9362Fe2fC75202C528", gas: true },
  { key: "relayer", name: "Relayer", what: "Delivers launches to the other chains in seconds", address: "0xB3D38B4007B287Ad852aa4fc5dA2c1029B6082ac", gas: true },
  { key: "rewards", name: "Rewards", what: "Pays invite rewards (10% of fees, Relay fees)", address: "0x4670db0a98Ac28D4093969E3Dfbf16045E321073" },
];
/** RaceBuilder: holds every coin's pool (the same address on every chain). */
const BUILDER = "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4" as Address;
const VAULT = WALLETS[1].address;
const SASA_SHARE = 0.7;
const ARC_USDC = "0x3600000000000000000000000000000000000000";

const builderAbi = parseAbi([
  "function collectFees(address coin) returns (uint256, uint256)",
  "function raceOver(address coin) view returns (bool)",
]);
const vaultAbi = parseAbi(["function distribute()", "function sweep(address token)"]);
const factoryAbi = parseAbi(["function owner() view returns (address)", "function launchesOpen() view returns (bool)", "function setLaunchesOpen(bool open)"]);
const TREASURY = WALLETS[0].address;
/** The race coins looked at for fees and for coins sasa holds (the newest first). */
const COINS_LOOKED_AT = 100;
/** Coins worth less than this aren't worth the gas of selling. */
const SELL_MIN_USD = 1;
/** Slippage allowed when selling sasa's coins (from the exact dry-run amount). */
const SELL_SLIP_BPS = 500n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Arc's gas IS its USDC: one balance, not two. */
const isArc = (c: RaceChain) => c.usd.toLowerCase() === ARC_USDC;

type Bal = { native: bigint; usd: bigint; usdDec: number };
type Pending = { coin: RaceCoin; chain: RaceChain; native: bigint; coins: bigint; usdValue: number; nativeValue: number; over: boolean };
/** Race coins sasa holds on a chain: in the vault (not yet swept) and in the treasury. */
type Held = { coin: RaceCoin; chain: RaceChain; inVault: bigint; inTreasury: bigint; usdValue: number };
type Launches = { chain: RaceChain; owner: Address | null; open: boolean | null };

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function prices(): Promise<{ ETH: number; BNB: number }> {
  const get = async (s: string) => {
    try {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`);
      const n = Number((await r.json())?.data?.amount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const [ETH, BNB] = await Promise.all([get("ETH"), get("BNB")]);
  return { ETH, BNB };
}

/** Dollars of `wei` native on `c` (Arc's native is USDC, 18 decimals). */
function nativeUsd(c: RaceChain, wei: bigint, p: { ETH: number; BNB: number }): number {
  const n = Number(formatUnits(wei, 18));
  if (isArc(c)) return n;
  return n * (c.chain.nativeCurrency.symbol === "BNB" ? p.BNB : p.ETH);
}
const balUsd = (c: RaceChain, b: Bal | undefined, p: { ETH: number; BNB: number }) =>
  !b ? 0 : (isArc(c) ? 0 : nativeUsd(c, b.native, p)) + Number(formatUnits(b.usd, b.usdDec));

async function hyperliquidValue(): Promise<number | null> {
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: HL_BUILDER }),
    });
    const v = Number((await r.json())?.marginSummary?.accountValue);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function MoneyPanel() {
  const w = useWallet();
  const [p, setP] = useState({ ETH: 0, BNB: 0 });
  const [bals, setBals] = useState<Record<string, Bal>>({});
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [held, setHeld] = useState<Held[] | null>(null);
  const [launches, setLaunches] = useState<Launches[]>([]);
  const [hl, setHl] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const pr = await prices();
    setP(pr);
    void hyperliquidValue().then(setHl);
    // every wallet's dollars and gas on every chain
    const out: Record<string, Bal> = {};
    await Promise.all(
      RACE_CHAINS.flatMap((c) =>
        WALLETS.map(async (wl) => {
          try {
            const pub = raceClient(c);
            const [native, usd, dec] = await Promise.all([
              pub.getBalance({ address: wl.address }),
              pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [wl.address] }) as Promise<bigint>,
              pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }) as Promise<number>,
            ]);
            out[`${wl.key}-${c.chainId}`] = { native, usd, usdDec: Number(dec) };
          } catch {
            // that chain didn't answer: shown as unknown
          }
        })
      )
    );
    // each contract set's fee vault (v7, v8…), chain by chain
    await Promise.all(
      RACE_SETS.flat().map(async (c) => {
        if (!c.feeVault) return;
        try {
          const pub = raceClient(c);
          const [native, usd, dec] = await Promise.all([
            pub.getBalance({ address: c.feeVault }),
            pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [c.feeVault] }) as Promise<bigint>,
            pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }) as Promise<number>,
          ]);
          out[`fv${c.stack}-${c.chainId}`] = { native, usd, usdDec: Number(dec) };
        } catch {}
      })
    );
    setBals(out);
    // fees waiting in each coin's pool, chain by chain (a dry run of collectFees: it says how much)
    const coins = await fetchRaceCoins(COINS_LOOKED_AT).catch(() => [] as RaceCoin[]);
    // launches open or paused on each chain, and who may change it (the factory's owner)
    void Promise.all(
      RACE_CHAINS.map(async (c): Promise<Launches> => {
        const pub = raceClient(c);
        const [owner, open] = await Promise.all([
          pub.readContract({ address: c.factory, abi: factoryAbi, functionName: "owner" }).catch(() => null) as Promise<Address | null>,
          pub.readContract({ address: c.factory, abi: factoryAbi, functionName: "launchesOpen" }).catch(() => null) as Promise<boolean | null>,
        ]);
        return { chain: c, owner, open };
      })
    ).then(setLaunches);
    // race coins sasa holds (its share of the sell fees), in the vault and in the treasury
    const hrows: Held[] = [];
    await Promise.all(
      coins.flatMap((coin) =>
        coin.lanes.map(async (lane) => {
          const c = lane.chain;
          try {
            const pub = raceClient(c);
            const [v, t] = await Promise.all(
              [c.feeVault ?? VAULT, TREASURY].map((a) => pub.readContract({ address: coin.coin, abi: raceErc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>)
            );
            if (v + t === 0n) return;
            hrows.push({ coin, chain: c, inVault: v, inTreasury: t, usdValue: Number(formatUnits(v + t, 18)) * (lane.priceUsd ?? 0) });
          } catch {
            // that chain didn't answer
          }
        })
      )
    );
    hrows.sort((a, b) => b.usdValue - a.usdValue);
    setHeld(hrows);
    const rows: Pending[] = [];
    await Promise.all(
      coins.flatMap((coin) =>
        coin.lanes.map(async (lane) => {
          const c = lane.chain;
          try {
            const pub = raceClient(c);
            const [sim, over] = await Promise.all([
              pub.simulateContract({ address: c.builder ?? BUILDER, abi: builderAbi, functionName: "collectFees", args: [coin.coin], account: c.feeVault ?? VAULT }),
              pub.readContract({ address: c.builder ?? BUILDER, abi: builderAbi, functionName: "raceOver", args: [coin.coin] }) as Promise<boolean>,
            ]);
            const [nat, cn] = sim.result as readonly [bigint, bigint];
            if (nat === 0n && cn === 0n) return;
            // pools trade against the chain's coin (ETH/BNB) or, on Arc, against USDC itself
            const natUsd = isArc(c) ? Number(formatUnits(nat, 6)) : nativeUsd(c, nat, pr);
            const coinUsd = Number(formatUnits(cn, 18)) * (lane.priceUsd ?? 0);
            rows.push({ coin, chain: c, native: nat, coins: cn, usdValue: (natUsd + coinUsd) * SASA_SHARE, nativeValue: natUsd * SASA_SHARE, over });
          } catch {
            // a pool that lost its race was closed out (its fees already went to the vault)
          }
        })
      )
    );
    rows.sort((a, b) => b.usdValue - a.usdValue);
    setPending(rows);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (key: string, c: RaceChain, to: Address, abi: typeof builderAbi | typeof vaultAbi | typeof factoryAbi, fn: string, args: readonly unknown[], done: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await w.send(c.chain, [call(to, abi as never, fn as never, args as never)], () => {});
      setMsg({ ok: true, text: done });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy("");
    }
  };

  const isTreasury = same(w.address, TREASURY);

  const sellCalls = (c: RaceChain, rows: Held[]) =>
    sellBatch({ pub: raceClient(c), router: c.router, vault: c.feeVault ?? VAULT, treasury: TREASURY, rows: rows.map((r) => ({ coin: r.coin.coin, inVault: r.inVault, inTreasury: r.inTreasury })) });

  /** Without a batch dry run: the sweeps and approvals first, then each sale priced on its own. */
  const sellStepByStep = async (c: RaceChain, prep: Call[], rows: Held[]) => {
    const pub = raceClient(c);
    if (prep.length) await w.send(c.chain, prep, () => {});
    for (const r of rows) {
      const amount = r.inVault + r.inTreasury;
      let out = 0n;
      for (let i = 0; i < 8 && out === 0n; i++) {
        // the node answering may be a block behind the approval
        const sim = await pub
          .simulateContract({ account: TREASURY, address: c.router, abi: raceRouterAbi, functionName: "sell", args: [r.coin.coin, amount, 0n, TREASURY, deadline()] })
          .catch(() => null);
        if (sim) out = sim.result as bigint;
        else await new Promise((res) => setTimeout(res, 1000));
      }
      if (out === 0n) throw new Error(`${r.coin.symbol} can't be sold on ${c.short} right now.`);
      await w.send(c.chain, [call(c.router, raceRouterAbi, "sell", [r.coin.coin, amount, (out * (10_000n - SELL_SLIP_BPS)) / 10_000n, TREASURY, deadline()])], () => {});
    }
  };

  /** One confirmation for the whole batch where the wallet can (EIP-5792), else one per step. */
  const sendBatch = async (c: RaceChain, calls: Call[]) => {
    try {
      await w.switchTo(c.chain);
      const wc = w.walletClient(c.chain);
      const { id } = await wc.sendCalls({ account: TREASURY, chain: c.chain, calls: calls.map((x) => ({ to: x.to, data: x.data })) });
      const st = await wc.waitForCallsStatus({ id, timeout: 120_000 });
      if (st.status !== "success") throw new Error("The network rejected the transaction.");
    } catch (e) {
      const m = String((e as { shortMessage?: string; message?: string; code?: number })?.message ?? "");
      const code = (e as { code?: number })?.code;
      // the wallet can't batch: the same steps, one confirmation each
      if (code === 4200 || code === -32601 || /not supported|does not support|unsupported|method not found|wallet_sendCalls/i.test(m)) {
        await w.send(c.chain, calls, () => {});
        return;
      }
      throw e;
    }
  };

  const sellChain = async (c: RaceChain) => {
    // one contract set at a time: each coin sells through its own set's router
    const rows = (held ?? []).filter((r) => r.chain === c && r.usdValue >= SELL_MIN_USD);
    if (!rows.length) return;
    const key = `sellall-${c.chainId}-${c.stack}`;
    setBusy(key);
    setMsg(null);
    try {
      const { prep, sells } = await sellCalls(c, rows);
      if (sells) await sendBatch(c, [...prep, ...sells]);
      else await sellStepByStep(c, prep, rows);
      setMsg({ ok: true, text: `Sold. The dollars are in the treasury on ${c.short}.` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy("");
    }
  };

  const sellOne = async (r: Held) => {
    const key = `sell-${r.coin.id}-${r.chain.chainId}`;
    setBusy(key);
    setMsg(null);
    try {
      const { prep, sells } = await sellCalls(r.chain, [r]);
      if (sells) await w.send(r.chain.chain, [...prep, ...sells], () => {});
      else await sellStepByStep(r.chain, prep, [r]);
      setMsg({ ok: true, text: `Sold ${r.coin.symbol}. The dollars are in the treasury on ${r.chain.short}.` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy("");
    }
  };

  const sumOf = (key: string) => RACE_CHAINS.reduce((s, c) => s + balUsd(c, bals[`${key}-${c.chainId}`], p), 0);
  const treasury = sumOf("treasury");
  const vault = sumOf("vault");
  const inPools = (pending ?? []).reduce((s, r) => s + r.usdValue, 0);
  const inPoolsNative = (pending ?? []).reduce((s, r) => s + r.nativeValue, 0);
  const heldUsd = (held ?? []).reduce((s, r) => s + r.usdValue, 0);
  const sellable = (held ?? []).filter((r) => r.usdValue >= SELL_MIN_USD);
  const lowGas = (c: RaceChain, b?: Bal) => {
    if (!b) return false;
    if (isArc(c)) return Number(formatUnits(b.usd, b.usdDec)) < 1;
    return b.native < (c.chain.nativeCurrency.symbol === "BNB" ? 2_000_000_000_000_000n : 500_000_000_000_000n);
  };

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-5 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display font-bold text-[1.375rem]">sasa money</h2>
          <p className="text-ink-3 text-[0.875rem]">Updates every minute. Fees reach the treasury in two steps: Collect, then Split.</p>
        </div>
        <button type="button" onClick={() => void load()} className="h-9 px-4 rounded-full border border-line text-[0.875rem] shrink-0">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "In the treasury", value: money(treasury), note: "Yours" },
          { label: "In the fee vault", value: money(vault), note: `${money(vault * 0.8)} goes to the treasury on Split` },
          { label: "Waiting in pools", value: pending === null ? "…" : money(inPools), note: `${money(inPoolsNative)} in ETH/BNB/USDC, the rest in coins` },
          { label: "Hyperliquid (perps fees)", value: hl === null ? "…" : money(hl), note: "Keep at least $100 there" },
        ].map((x) => (
          <div key={x.label} className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
            <div className="text-[0.75rem] text-ink-3">{x.label}</div>
            <div className="font-display font-bold text-[1.25rem] sm:text-[1.5rem] truncate">{x.value}</div>
            <div className="text-[0.75rem] text-ink-3">{x.note}</div>
          </div>
        ))}
      </div>

      {msg && (
        <p role="status" className={"text-[0.875rem] " + (msg.ok ? "text-up" : "text-danger")}>
          {msg.text}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Fees waiting in pools</h3>
        {pending === null && <div className="h-16 rounded-2xl bg-night animate-pulse" />}
        {pending && pending.length === 0 && <p className="text-[0.875rem] text-ink-3">No fees waiting.</p>}
        {pending?.map((r) => {
          const key = `collect-${r.coin.id}-${r.chain.chainId}`;
          return (
            <div key={key} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-3">
              <div className="flex-1 min-w-[10rem]">
                <div className="font-semibold truncate">
                  {r.coin.name} <span className="text-ink-3">{r.coin.symbol}</span> · {r.chain.short}
                </div>
                <div className="text-[0.8125rem] text-ink-3">
                  sasa&apos;s share: {money(r.usdValue)} ({money(r.nativeValue)} in {isArc(r.chain) ? "USDC" : r.chain.chain.nativeCurrency.symbol}, the rest in {r.coin.symbol})
                </div>
              </div>
              <button
                type="button"
                disabled={!!busy || !r.over}
                onClick={() => void run(key, r.chain, r.chain.builder ?? BUILDER, builderAbi, "collectFees", [r.coin.coin], `Collected. sasa's share is in the fee vault on ${r.chain.short}.`)}
                className="h-10 px-5 rounded-full bg-ink text-paper font-semibold text-[0.875rem] disabled:opacity-40"
                title={r.over ? "" : "Can be collected once this chain's 5 minutes are over"}
              >
                {busy === key ? "Collecting…" : r.over ? "Collect" : "Racing"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Fee vault → treasury</h3>
        <div className="grid sm:grid-cols-2 gap-2">
          {RACE_SETS.flat().map((c) => {
            const v = balUsd(c, bals[`fv${c.stack}-${c.chainId}`] ?? bals[`vault-${c.chainId}`], p);
            const key = `split-${c.chainId}-${c.stack}`;
            return (
              <div key={key} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                <div className="flex-1">
                  <div className="font-semibold">{c.short}{RACE_SETS.length > 1 ? ` · v${c.stack}` : ""}</div>
                  <div className="text-[0.8125rem] text-ink-3">{money(v)} in the vault</div>
                </div>
                <button
                  type="button"
                  disabled={!!busy || v < 0.01}
                  onClick={() => void run(key, c, c.feeVault ?? VAULT, vaultAbi, "distribute", [], `Split on ${c.short}: 80% is in the treasury.`)}
                  className="h-10 px-5 rounded-full bg-ink text-paper font-semibold text-[0.875rem] disabled:opacity-40"
                >
                  {busy === key ? "Splitting…" : "Split"}
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[0.75rem] text-ink-3">The keeper also does both by itself (after each race, and when the vault holds $5 or more). The buttons only make it happen now; your wallet pays a few cents of gas.</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Coins sasa holds {held && heldUsd > 0 ? <span className="text-ink-3 font-normal">· about {money(heldUsd)}</span> : null}</h3>
        <p className="text-[0.8125rem] text-ink-3">
          Sell fees are paid in the coin itself. Selling turns them into dollars (USDC) in the treasury. Coins under {money(SELL_MIN_USD)} are left alone (not worth the gas).
          {!isTreasury && " To sell, connect the treasury wallet (0x3C4E…a6F)."}
        </p>
        {held === null && <div className="h-16 rounded-2xl bg-night animate-pulse" />}
        {held && held.length === 0 && <p className="text-[0.875rem] text-ink-3">None yet.</p>}
        {held?.map((r) => {
          const key = `sell-${r.coin.id}-${r.chain.chainId}`;
          return (
            <div key={key} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line p-3">
              <div className="flex-1 min-w-[10rem]">
                <div className="font-semibold truncate">
                  {r.coin.name} <span className="text-ink-3">{r.coin.symbol}</span> · {r.chain.short}
                </div>
                <div className="text-[0.8125rem] text-ink-3">
                  {Number(formatUnits(r.inVault + r.inTreasury, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 })} {r.coin.symbol} · about {money(r.usdValue)}
                </div>
              </div>
              <button
                type="button"
                disabled={!!busy || !isTreasury || r.usdValue < SELL_MIN_USD}
                onClick={() => void sellOne(r)}
                className="h-10 px-5 rounded-full border border-line font-semibold text-[0.875rem] disabled:opacity-40"
              >
                {busy === key ? "Selling…" : "Sell"}
              </button>
            </div>
          );
        })}
        {sellable.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...new Set(sellable.map((r) => r.chain))].map((c) => (
              <button
                key={`${c.chainId}-${c.stack}`}
                type="button"
                disabled={!!busy || !isTreasury}
                onClick={() => void sellChain(c)}
                className="h-11 px-5 rounded-full bg-ink text-paper font-semibold text-[0.875rem] disabled:opacity-40"
              >
                {busy === `sellall-${c.chainId}-${c.stack}` ? "Selling…" : `Sell all on ${c.short}${RACE_SETS.length > 1 ? ` (v${c.stack})` : ""} for USDC`}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Launches</h3>
        <p className="text-[0.8125rem] text-ink-3">Emergency stop: pausing a chain stops new coins there. Trading, selling and races keep working.</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {launches.map((l) => {
            const key = `launch-${l.chain.chainId}`;
            const mine = same(w.address, l.owner);
            return (
              <div key={key} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                <div className="flex-1">
                  <div className="font-semibold">{l.chain.short}</div>
                  <div className={"text-[0.8125rem] " + (l.open === false ? "text-danger" : "text-ink-3")}>{l.open === null ? "Couldn't read" : l.open ? "Open" : "Paused"}</div>
                </div>
                <button
                  type="button"
                  disabled={!!busy || !mine || l.open === null}
                  title={mine ? "" : "Only the factory's owner can do this"}
                  onClick={() => void run(key, l.chain, l.chain.factory, factoryAbi as never, "setLaunchesOpen", [!l.open], l.open ? `Launches paused on ${l.chain.short}.` : `Launches open again on ${l.chain.short}.`)}
                  className={"h-10 px-5 rounded-full font-semibold text-[0.875rem] disabled:opacity-40 " + (l.open ? "bg-danger text-white" : "bg-ink text-paper")}
                >
                  {busy === key ? "…" : l.open ? "Pause" : "Open"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        <h3 className="font-semibold">Wallets</h3>
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-[0.8125rem] min-w-[36rem]">
            <thead>
              <tr className="text-ink-3 text-left">
                <th className="py-1 pr-3 font-normal">Wallet</th>
                {RACE_CHAINS.map((c) => (
                  <th key={c.chainId} className="py-1 pr-3 font-normal">
                    {c.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WALLETS.map((wl) => (
                <tr key={wl.key} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <div className="font-semibold">{wl.name}</div>
                    <div className="text-ink-3 max-w-[16rem]">{wl.what}</div>
                  </td>
                  {RACE_CHAINS.map((c) => {
                    const b = bals[`${wl.key}-${c.chainId}`];
                    const low = wl.gas && lowGas(c, b);
                    return (
                      <td key={c.chainId} className="py-2 pr-3 whitespace-nowrap">
                        <a href={raceExplorerAddress(c, wl.address)} target="_blank" rel="noreferrer" className="hover:underline">
                          {b ? money(balUsd(c, b, p)) : "…"}
                        </a>
                        {b && !isArc(c) && (
                          <div className={low ? "text-danger" : "text-ink-3"}>
                            {Number(formatUnits(b.native, 18)).toFixed(4)} {c.chain.nativeCurrency.symbol}
                            {low ? " · low gas" : ""}
                          </div>
                        )}
                        {b && isArc(c) && low && <div className="text-danger">low gas</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/**
 * The calls that sell sasa's coins on one chain for dollars to the treasury: sweep each coin out
 * of the vault, approve the router, sell. Each sale's minimum is the exact amount from a dry run of
 * the whole batch, less 5%. `sells` is null when the node can't dry-run a batch (then the caller
 * sends the sweeps and approvals first and prices each sale on its own).
 */
export async function sellBatch(o: {
  pub: ReturnType<typeof raceClient>;
  router: Address;
  vault: Address;
  treasury: Address;
  rows: { coin: Address; inVault: bigint; inTreasury: bigint }[];
}): Promise<{ prep: Call[]; sells: Call[] | null }> {
  const prep: Call[] = [];
  const sells: { coin: Address; amount: bigint }[] = [];
  for (const r of o.rows) {
    const amount = r.inVault + r.inTreasury;
    if (r.inVault > 0n) prep.push(call(o.vault, vaultAbi, "sweep", [r.coin]));
    const allowance = (await o.pub.readContract({ address: r.coin, abi: raceErc20Abi, functionName: "allowance", args: [o.treasury, o.router] })) as bigint;
    if (allowance < amount) prep.push(call(r.coin, raceErc20Abi, "approve", [o.router, maxUint256]));
    sells.push({ coin: r.coin, amount });
  }
  const probe = [...prep, ...sells.map((x) => call(o.router, raceRouterAbi, "sell", [x.coin, x.amount, 0n, o.treasury, deadline()]))];
  let outs: { status: string; data: Hex }[];
  try {
    const sim = await o.pub.simulateCalls({ account: o.treasury, calls: probe.map((x) => ({ to: x.to, data: x.data })) });
    outs = sim.results.slice(prep.length) as never;
  } catch {
    // this chain's node can't dry-run several steps at once
    return { prep, sells: null };
  }
  if (outs.some((x) => x.status !== "success" || !x.data || x.data.length < 66)) throw new Error("One of these coins can't be sold on this chain right now. Sell them one by one.");
  return {
    prep,
    sells: sells.map((x, i) => {
      const out = BigInt(outs[i].data.slice(0, 66));
      return call(o.router, raceRouterAbi, "sell", [x.coin, x.amount, (out * (10_000n - SELL_SLIP_BPS)) / 10_000n, o.treasury, deadline()]);
    }),
  };
}
