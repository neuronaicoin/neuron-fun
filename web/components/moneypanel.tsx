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
import { formatUnits, parseAbi, type Address } from "viem";
import { useWallet } from "@/components/wallet";
import { RACE_CHAINS, fetchRaceCoins, raceClient, raceErc20Abi, raceExplorerAddress, type RaceChain, type RaceCoin } from "@/lib/race";
import { HL_BUILDER } from "@/lib/config";
import { call } from "@/lib/tx";
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
const vaultAbi = parseAbi(["function distribute()"]);

/** Arc's gas IS its USDC: one balance, not two. */
const isArc = (c: RaceChain) => c.usd.toLowerCase() === ARC_USDC;

type Bal = { native: bigint; usd: bigint; usdDec: number };
type Pending = { coin: RaceCoin; chain: RaceChain; native: bigint; coins: bigint; usdValue: number; over: boolean };

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
    setBals(out);
    // fees waiting in each coin's pool, chain by chain (a dry run of collectFees: it says how much)
    const coins = await fetchRaceCoins(30).catch(() => [] as RaceCoin[]);
    const rows: Pending[] = [];
    await Promise.all(
      coins.flatMap((coin) =>
        coin.lanes.map(async (lane) => {
          const c = lane.chain;
          try {
            const pub = raceClient(c);
            const [sim, over] = await Promise.all([
              pub.simulateContract({ address: BUILDER, abi: builderAbi, functionName: "collectFees", args: [coin.coin], account: VAULT }),
              pub.readContract({ address: BUILDER, abi: builderAbi, functionName: "raceOver", args: [coin.coin] }) as Promise<boolean>,
            ]);
            const [nat, cn] = sim.result as readonly [bigint, bigint];
            if (nat === 0n && cn === 0n) return;
            // pools trade against the chain's coin (ETH/BNB) or, on Arc, against USDC itself
            const natUsd = isArc(c) ? Number(formatUnits(nat, 6)) : nativeUsd(c, nat, pr);
            const coinUsd = Number(formatUnits(cn, 18)) * (lane.priceUsd ?? 0);
            rows.push({ coin, chain: c, native: nat, coins: cn, usdValue: (natUsd + coinUsd) * SASA_SHARE, over });
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

  const run = async (key: string, c: RaceChain, to: Address, abi: typeof builderAbi | typeof vaultAbi, fn: string, args: readonly unknown[], done: string) => {
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

  const sumOf = (key: string) => RACE_CHAINS.reduce((s, c) => s + balUsd(c, bals[`${key}-${c.chainId}`], p), 0);
  const treasury = sumOf("treasury");
  const vault = sumOf("vault");
  const inPools = (pending ?? []).reduce((s, r) => s + r.usdValue, 0);
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
          { label: "Waiting in pools", value: pending === null ? "…" : money(inPools), note: "sasa's 70%, after Collect" },
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
                <div className="text-[0.8125rem] text-ink-3">sasa&apos;s share: {money(r.usdValue)}</div>
              </div>
              <button
                type="button"
                disabled={!!busy || !r.over}
                onClick={() => void run(key, r.chain, BUILDER, builderAbi, "collectFees", [r.coin.coin], `Collected. sasa's share is in the fee vault on ${r.chain.short}.`)}
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
          {RACE_CHAINS.map((c) => {
            const v = balUsd(c, bals[`vault-${c.chainId}`], p);
            const key = `split-${c.chainId}`;
            return (
              <div key={key} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                <div className="flex-1">
                  <div className="font-semibold">{c.short}</div>
                  <div className="text-[0.8125rem] text-ink-3">{money(v)} in the vault</div>
                </div>
                <button
                  type="button"
                  disabled={!!busy || v < 0.01}
                  onClick={() => void run(key, c, VAULT, vaultAbi, "distribute", [], `Split on ${c.short}: 80% is in the treasury.`)}
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
