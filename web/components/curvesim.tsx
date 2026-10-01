"use client";

/**
 * Bonding curve simulator: pick how much a coin has raised and how much you
 * buy, and see what you get. Same maths as the curve contract (UsdCurve):
 * constant product on virtual reserves, with the 1% fee taken on top.
 *
 *   net      = buy / (1 + fee)
 *   tokens   = T - V * T / (V + net)          (V, T: virtual USDC and tokens)
 *
 * The curve settings are read from the live factory, so the numbers follow the
 * contracts (testnet today, mainnet later) without editing this file.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { CHAINS, TARGET_USD } from "@/lib/config";
import { factoryAbi } from "@/lib/abis";
import { clientFor } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { compactUsd } from "@/lib/format";

export type CurveTerms = {
  /** Virtual money at the start, in USD. */
  v0Usd: number;
  /** Virtual tokens at the start (whole tokens). */
  t0: number;
  /** Tokens the curve can sell before graduation. */
  forSale: number;
  feeBps: number;
};

const SUPPLY = 1_000_000_000;
// Testnet settings, used until the factory answers (and if it can't be reached).
const FALLBACK: CurveTerms = { v0Usd: 100, t0: 1_073_000_000, forSale: 793_100_000, feeBps: 100 };

let cached: CurveTerms | null = null;
async function loadTerms(): Promise<CurveTerms | null> {
  if (cached) return cached;
  const c = CHAINS[0];
  const [r, prices] = await Promise.all([
    clientFor(c).readContract({ address: c.factory, abi: factoryAbi, functionName: "config" }) as Promise<readonly [bigint, bigint, bigint, bigint, number, number, bigint]>,
    fetchPrices(),
  ]);
  const unit = prices?.ETH;
  if (!unit) return null;
  const t: CurveTerms = {
    v0Usd: (Number(r[0]) / 1e18) * unit,
    t0: Number(r[1]) / 1e18,
    forSale: Number(r[2]) / 1e18,
    feeBps: Number(r[4]),
  };
  if (!(t.v0Usd > 0 && t.t0 > t.forSale && t.forSale > 0)) return null;
  cached = t;
  return t;
}

function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
const money = (n: number) => (n >= 1000 ? compactUsd(n) : `$${n.toFixed(2)}`);

export function CurveSim({ title = "See what your buy does", className = "" }: { title?: string; className?: string }) {
  const [terms, setTerms] = useState<CurveTerms>(cached ?? FALLBACK);
  // Slider positions, 0-1000.
  const [raisedPos, setRaisedPos] = useState(200);
  const [buyPos, setBuyPos] = useState(250);
  const id = useId();

  useEffect(() => {
    let alive = true;
    loadTerms()
      .then((t) => alive && t && setTerms(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const r = useMemo(() => {
    const { v0Usd: V0, t0: T0, forSale, feeBps } = terms;
    const fee = feeBps / 10_000;
    const k = V0 * T0;
    // The curve stops at the graduation target, or when its coins for sale run out.
    const capRaised = Math.min(TARGET_USD, k / (T0 - forSale) - V0);
    const at = (raised: number) => {
      const v = V0 + raised;
      const t = k / v;
      return { v, t, price: v / t };
    };
    const mcAt = (raised: number) => at(raised).price * SUPPLY;

    const raised = capRaised * 0.98 * (raisedPos / 1000);
    const maxBuy = (capRaised - raised) * (1 + fee);
    const buy = Math.max(0.01, maxBuy * (buyPos / 1000));
    const net = buy / (1 + fee);
    const before = at(raised);
    const after = at(raised + net);
    const got = before.t - after.t;
    const avg = net / got;
    const impact = (avg / before.price - 1) * 100;
    const worth = got * at(capRaised).price;
    return {
      capRaised,
      raised,
      buy,
      net,
      got,
      share: (got / SUPPLY) * 100,
      mcAfter: mcAt(raised + net),
      mcStart: mcAt(0),
      mcEnd: mcAt(capRaised),
      impact,
      worth,
      mult: worth / buy,
      mcAt,
    };
  }, [terms, raisedPos, buyPos]);

  // Curve drawing: market cap against money raised.
  const W = 400;
  const H = 180;
  const L = 6;
  const R = 6;
  const TOP = 18;
  const B = 24;
  const x = (raised: number) => L + (raised / r.capRaised) * (W - L - R);
  const y = (mc: number) => TOP + (1 - (mc - r.mcStart) / (r.mcEnd - r.mcStart || 1)) * (H - TOP - B);
  let line = "";
  for (let i = 0; i <= 60; i++) {
    const v = (r.capRaised * i) / 60;
    line += `${i ? "L" : "M"}${x(v).toFixed(1)} ${y(r.mcAt(v)).toFixed(1)}`;
  }
  const a = r.raised;
  const b = r.raised + r.net;
  let area = `M${x(a).toFixed(1)} ${H - B}`;
  for (let i = 0; i <= 24; i++) {
    const v = a + ((b - a) * i) / 24;
    area += `L${x(v).toFixed(1)} ${y(r.mcAt(v)).toFixed(1)}`;
  }
  area += `L${x(b).toFixed(1)} ${H - B}Z`;
  const pBefore = (r.raised / r.capRaised) * 100;
  const pBuy = (r.net / r.capRaised) * 100;

  const quick = [
    [100, "10%"],
    [250, "25%"],
    [500, "50%"],
    [1000, "Max"],
  ] as const;

  return (
    <section className={"rounded-3xl border border-line bg-surface p-4 sm:p-5 " + className} aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="font-display font-bold text-[1.125rem] sm:text-[1.25rem] text-ink">
        {title}
      </h2>
      <p className="text-[0.8125rem] text-ink-2 mt-1 leading-snug">
        Pick how far the coin is along its curve and how much you buy. Same formula as the contract.
      </p>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[0.8125rem] text-ink-3">
          <label htmlFor={`${id}-r`}>Already raised</label>
          <span className="font-mono text-[1.0625rem] text-ink">{money(r.raised)}</span>
        </div>
        <input
          id={`${id}-r`}
          type="range"
          min={0}
          max={1000}
          value={raisedPos}
          onChange={(e) => setRaisedPos(Number(e.target.value))}
          className="w-full h-7 mt-1"
          style={{ accentColor: "var(--color-emerald)" }}
        />
      </div>

      <div className="mt-2">
        <div className="flex items-baseline justify-between text-[0.8125rem] text-ink-3">
          <label htmlFor={`${id}-b`}>Your buy</label>
          <span className="font-mono text-[1.0625rem] text-ink">{money(r.buy)}</span>
        </div>
        <input
          id={`${id}-b`}
          type="range"
          min={1}
          max={1000}
          value={buyPos}
          onChange={(e) => setBuyPos(Number(e.target.value))}
          className="w-full h-7 mt-1"
          style={{ accentColor: "var(--color-emerald)" }}
        />
        <div className="flex gap-1.5 mt-1">
          {quick.map(([v, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={buyPos === v}
              onClick={() => setBuyPos(v)}
              className={
                "h-8 flex-1 rounded-lg border text-[0.75rem] font-semibold " +
                (buyPos === v ? "bg-ink text-paper border-ink" : "bg-paper border-line text-ink-2 hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-[0.75rem] text-ink-3">
          <span>Graduation progress</span>
          <span className="font-mono">{Math.min(100, pBefore + pBuy).toFixed(0)}%</span>
        </div>
        <div className="relative h-2 mt-1.5 rounded-full bg-line overflow-hidden">
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald" style={{ width: `${pBefore}%` }} />
          <div className="absolute inset-y-0 bg-mint" style={{ left: `${pBefore}%`, width: `${pBuy}%` }} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="col-span-2 rounded-2xl border border-emerald/40 bg-emerald-soft px-3 py-2.5">
          <div className="text-[0.6875rem] text-ink-3">Your coins at graduation</div>
          <div className="font-mono font-semibold text-[1.375rem] text-emerald leading-tight mt-0.5">
            {money(r.worth)} <span className="text-[0.9375rem]">({r.mult.toFixed(2)}×)</span>
          </div>
        </div>
        {[
          ["You get", tokensText(r.got)],
          ["Share of supply", `${r.share.toFixed(2)}%`],
          ["Market cap after", compactUsd(r.mcAfter)],
          ["Price impact", `+${r.impact.toFixed(2)}%`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-line bg-paper px-3 py-2 min-w-0">
            <div className="text-[0.6875rem] text-ink-3">{k}</div>
            <div className="font-mono font-semibold text-[1rem] truncate">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-2xl border border-line bg-paper p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" role="img" aria-label="Market cap along the bonding curve, with your buy highlighted">
          <path d={area} style={{ fill: "var(--color-emerald)", opacity: 0.2 }} />
          <path d={line} style={{ fill: "none", stroke: "var(--color-emerald)", strokeWidth: 2.5, strokeLinecap: "round" }} />
          <line x1={L} x2={W - R} y1={H - B} y2={H - B} style={{ stroke: "var(--color-line)" }} />
          <circle cx={x(a)} cy={y(r.mcAt(a))} r={5} style={{ fill: "var(--color-surface)", stroke: "var(--color-emerald)", strokeWidth: 2.5 }} />
          <circle cx={x(b)} cy={y(r.mcAt(b))} r={5.5} style={{ fill: "var(--color-emerald)" }} />
          <text x={L} y={H - 7} style={{ fill: "var(--color-ink-3)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            $0 raised
          </text>
          <text x={W - R} y={H - 7} textAnchor="end" style={{ fill: "var(--color-ink-3)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            🎓 {money(r.capRaised)}
          </text>
          <text x={W - R} y={TOP - 5} textAnchor="end" style={{ fill: "var(--color-ink-3)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            MC {compactUsd(r.mcEnd)}
          </text>
        </svg>
      </div>

      <p className="text-[0.75rem] text-ink-3 mt-3 leading-snug">
        Graduates at {money(TARGET_USD)} raised across all chains (shown here as if every buy is on one chain). The {terms.feeBps / 100}% fee is included. Early
        buys get more coins per USDC because the price rises with every buy. An estimate: trades before yours change the result.
      </p>
    </section>
  );
}
