"use client";

/**
 * "Who holds this coin": every holder as a bubble sized by their share,
 * the creator, you and the biggest holder in their own colours, and wallets
 * that sent the coin to each other joined by a dashed line. A list view
 * (the old top-holders table) is one tap away.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Coin } from "@/lib/data";
import { fetchHolderMap, packCircles, type HolderMapData } from "@/lib/holders";
import { useLocks, timeLeft, useNow } from "@/lib/lock";
import { profileHref, useProfiles } from "@/lib/social";
import { shortAddr } from "@/lib/format";
import { useWallet } from "./wallet";
import { TopHolders } from "./market";

const W = 680;
const H = 420;
const COLOR = { creator: "#ff6b1a", you: "#2fd39b", top: "#ef5b52", holder: "#8a5cf6" } as const;
type Kind = keyof typeof COLOR;

export function HolderMap({ coin }: { coin: Coin }) {
  const { address } = useWallet();
  const [chainKey, setChainKey] = useState<string | null>(coin.curves.length > 1 ? null : coin.curves[0]?.chain.key ?? null);
  const [view, setView] = useState<"map" | "list">("map");
  const [data, setData] = useState<HolderMapData | null>(null);
  const [error, setError] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const locks = useLocks([coin.id]);
  const now = useNow(60_000);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    setPicked(null);
    fetchHolderMap(coin, chainKey)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id, chainKey]);

  const creator = coin.creator.toLowerCase();
  const me = address?.toLowerCase() ?? "";
  const profiles = useProfiles(useMemo(() => (data?.holders ?? []).slice(0, 30).map((h) => h.addr), [data]));

  const layout = useMemo(() => {
    if (!data || !data.holders.length) return [];
    const max = data.holders[0].share;
    const top = data.holders.find((h) => h.addr !== creator)?.addr;
    const items = data.holders.map((h) => ({
      ...h,
      r: Math.max(8, Math.sqrt(h.share / max) * 88),
      kind: (h.addr === creator ? "creator" : h.addr === me ? "you" : h.addr === top ? "top" : "holder") as Kind,
    }));
    return packCircles(items, W, H);
  }, [data, creator, me]);

  const linked = useMemo(() => new Set((data?.links ?? []).flat()), [data]);
  const pos = useMemo(() => new Map(layout.map((p) => [p.addr, p])), [layout]);
  const top10 = (data?.holders ?? []).slice(0, 10).reduce((s, h) => s + h.share, 0);
  const creatorShare = data?.holders.find((h) => h.addr === creator)?.share ?? 0;
  const linkedShare = (data?.holders ?? []).filter((h) => linked.has(h.addr)).reduce((s, h) => s + h.share, 0);
  const lockUntil = locks.get(coin.id);
  const locked = !!lockUntil && lockUntil > now;
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const listCurve = coin.curves.find((c) => c.chain.key === chainKey) ?? coin.graduatedOn ?? coin.curves[0];
  const sel = picked ? layout.find((p) => p.addr === picked) : null;
  const selName = (a: string) => {
    const p = profiles.get(a);
    return a === creator ? "Creator" : a === me ? "You" : p?.username ? `@${p.username}` : shortAddr(a);
  };

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-display font-semibold text-[1.125rem]">Who holds ${coin.symbol}</h2>
        <div className="flex gap-1 p-1 rounded-xl bg-paper" role="group" aria-label="View">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold " + (view === v ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-3")}
            >
              {v === "map" ? "Map" : "List"}
            </button>
          ))}
        </div>
      </div>

      {coin.curves.length > 1 && (
        <div className="flex gap-1.5 mt-3 flex-wrap" role="group" aria-label="Chain">
          {[{ key: null as string | null, short: "All chains" }, ...coin.curves.map((c) => ({ key: c.chain.key as string | null, short: c.chain.short }))]
            .filter((c) => view === "map" || c.key !== null)
            .map((c) => (
              <button
                key={c.key ?? "all"}
                type="button"
                aria-pressed={chainKey === c.key}
                onClick={() => setChainKey(c.key)}
                className={"h-8 px-3 rounded-full border text-[0.75rem] font-semibold " + (chainKey === c.key ? "border-emerald text-ink" : "border-line text-ink-2")}
              >
                {c.short}
              </button>
            ))}
        </div>
      )}

      {view === "list" ? (
        listCurve && (
          <div className="mt-3">
            <TopHolders curve={listCurve} />
          </div>
        )
      ) : error ? (
        <p className="text-[0.875rem] text-ink-3 mt-4">Couldn&apos;t load the holders. Try again in a moment.</p>
      ) : !data ? (
        <div className="shimmer rounded-2xl mt-4 aspect-[680/420]" />
      ) : !data.holders.length ? (
        <p className="text-[0.875rem] text-ink-3 mt-4">No holders yet. Be the first to buy.</p>
      ) : (
        <>
          <div className="relative mt-3">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`Holder map: top 10 wallets hold ${pct(top10)}`}>
              {layout.map((p) => (
                <g
                  key={p.addr}
                  role="button"
                  tabIndex={0}
                  aria-label={`${selName(p.addr)}: ${pct(p.share)}`}
                  onClick={() => setPicked((x) => (x === p.addr ? null : p.addr))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPicked((x) => (x === p.addr ? null : p.addr));
                    }
                  }}
                  className="cursor-pointer focus:outline-none"
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={COLOR[p.kind]}
                    fillOpacity={p.kind === "holder" ? 0.55 : 0.9}
                    stroke={picked === p.addr ? "var(--color-ink)" : linked.has(p.addr) ? "#f6c56d" : "none"}
                    strokeWidth={picked === p.addr ? 3 : 2.5}
                  />
                  {p.r > 24 && (
                    <text x={p.x} y={p.y + 5} textAnchor="middle" fontFamily="var(--font-mono)" fontWeight="600" fontSize={Math.min(18, p.r / 2.6)} fill="#fff">
                      {pct(p.share)}
                    </text>
                  )}
                  {p.kind === "creator" && locked && p.r > 24 && (
                    <text x={p.x} y={p.y - p.r * 0.38} textAnchor="middle" fontSize={p.r / 3.2}>
                      🔒
                    </text>
                  )}
                </g>
              ))}
              {/* On top of the bubbles so the links stay visible. */}
              <g pointerEvents="none">
                {(data.links ?? []).map(([a, b], i) => {
                  const p = pos.get(a);
                  const q = pos.get(b);
                  return p && q ? (
                    <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#f6c56d" strokeWidth="2" strokeDasharray="4 5" opacity="0.85" />
                  ) : null;
                })}
              </g>
            </svg>
          </div>

          {sel ? (
            <div className="mt-2 rounded-xl bg-paper px-3 py-2.5 flex items-center justify-between gap-3 text-[0.875rem]">
              <span className="min-w-0">
                <span className="font-semibold">{selName(sel.addr)}</span>
                <span className="text-ink-3"> · {pct(sel.share)} of supply</span>
                {linked.has(sel.addr) && <span className="text-warn-ink"> · linked wallet</span>}
                {sel.kind === "creator" && locked && lockUntil && <span className="text-up"> · 🔒 {timeLeft(lockUntil, now)} left</span>}
              </span>
              <Link href={profileHref(profiles.get(sel.addr) ?? { address: sel.addr as `0x${string}`, username: null })} className="shrink-0 font-bold text-emerald">
                Profile
              </Link>
            </div>
          ) : (
            <p className="text-[0.75rem] text-ink-3 mt-2">Bigger bubble, bigger share. Tap one to see who it is.</p>
          )}

          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[0.75rem] text-ink-2">
            {(
              [
                ["creator", "Creator"],
                ["top", "Biggest holder"],
                ["you", "You"],
                ["holder", "Other holders"],
              ] as const
            ).map(([k, l]) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLOR[k], opacity: k === "holder" ? 0.6 : 1 }} />
                {l}
              </span>
            ))}
            {data.links.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed border-[#f6c56d]" />
                Linked wallets
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
            <Stat label="Top 10 hold" value={pct(top10)} tone={top10 > 0.5 ? "warn" : "good"} />
            <Stat label="Creator holds" value={pct(creatorShare)} tone={creatorShare > 0.1 ? "warn" : undefined} note={locked && lockUntil ? `🔒 ${timeLeft(lockUntil, now)}` : undefined} />
            <Stat label="Linked wallets" value={pct(linkedShare)} tone={linkedShare > 0.1 ? "warn" : undefined} />
            <Stat label="Shown" value={String(data.holders.length)} note="biggest wallets" />
          </div>
          {data.links.length > 0 && (
            <p className="text-[0.75rem] text-ink-3 mt-2">
              Linked wallets sent this coin to each other. Often that&apos;s one person spreading a bag across wallets.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone, note }: { label: string; value: string; tone?: "good" | "warn"; note?: string }) {
  return (
    <div className="rounded-xl bg-paper px-3 py-2.5">
      <div className="text-[0.6875rem] text-ink-3">{label}</div>
      <div className={"font-display font-semibold text-[1.125rem] " + (tone === "warn" ? "text-warn-ink" : tone === "good" ? "text-up" : "")}>{value}</div>
      {note && <div className="text-[0.6875rem] text-ink-3">{note}</div>}
    </div>
  );
}
