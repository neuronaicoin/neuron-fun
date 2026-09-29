"use client";

/**
 * Top traders as bubbles: size is how much they traded, green made money,
 * red lost it, with their picture inside. Tap one for their numbers and
 * Follow / Copy. Works the same with a mouse, a finger or the keyboard.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { packCircles } from "@/lib/holders";
import { displayName, isQuickSeller, profileHref, winRate, type Profile, type TraderStats } from "@/lib/social";
import { signed } from "@/lib/portfolio";
import { Avatar, FollowButton } from "./social";
import { CopyBadge, CopyButton } from "./copy";

// Wide on computers, tall on phones, so bubbles stay big enough to tap.
const WIDE = { w: 760, h: 470, max: 96 };
const TALL = { w: 420, h: 560, max: 80 };
const UP = "#1fbf86";
const DN = "#e5534b";

export function TraderBubbles({ rows, profiles, ethUsd }: { rows: TraderStats[]; profiles: Map<string, Profile>; ethUsd: number | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setTall(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const { w: W, h: H, max: MAXR } = tall ? TALL : WIDE;

  const layout = useMemo(() => {
    const list = rows.slice(0, 40);
    const max = Math.max(...list.map((r) => r.volume), 1e-12);
    const items = list.map((r, rank) => ({ ...r, rank, r: Math.max(16, Math.sqrt(Math.max(r.volume, 0) / max) * MAXR) }));
    // The picture sits in the upper part of big bubbles and fills small ones.
    return packCircles(items, W, H).map((p) => {
      const big = p.r >= 40;
      return { ...p, big, ir: big ? p.r * 0.42 : p.r * 0.62, ay: big ? p.y - p.r * 0.18 : p.y };
    });
  }, [rows, W, H, MAXR]);

  const sel = picked ? layout.find((p) => p.trader === picked) : null;
  const money = (eth: number) => (ethUsd !== null ? signed(eth * ethUsd) : `${eth.toFixed(4)} ETH`);
  const nameOf = (a: string) => {
    const p = profiles.get(a);
    return p ? displayName(p) : `${a.slice(0, 6)}…${a.slice(-4)}`;
  };

  return (
    <div className="mt-4 bg-surface border border-line rounded-2xl p-3 sm:p-5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block select-none" role="img" aria-label="Top traders as bubbles">
        <defs>
          {layout.map((p) => (
            <clipPath key={p.trader} id={`tb-${p.trader}`}>
              <circle cx={p.x} cy={p.ay} r={p.ir} />
            </clipPath>
          ))}
        </defs>
        {layout.map((p) => {
          const prof = profiles.get(p.trader);
          const up = p.realized >= 0;
          const on = picked === p.trader;
          const { big, ir, ay } = p;
          return (
            <g
              key={p.trader}
              role="button"
              tabIndex={0}
              aria-label={`${nameOf(p.trader)}: ${money(p.realized)}, ${p.trades} trades`}
              aria-pressed={on}
              onClick={() => setPicked((x) => (x === p.trader ? null : p.trader))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPicked((x) => (x === p.trader ? null : p.trader));
                }
              }}
              className="cursor-pointer focus:outline-none"
            >
              <circle cx={p.x} cy={p.y} r={p.r} fill={up ? UP : DN} fillOpacity={on ? 1 : 0.82} stroke={on ? "var(--color-ink)" : "rgba(255,255,255,0.35)"} strokeWidth={on ? 3 : 1.5} />
              {prof?.avatar ? (
                <image href={prof.avatar} x={p.x - ir} y={ay - ir} width={ir * 2} height={ir * 2} clipPath={`url(#tb-${p.trader})`} preserveAspectRatio="xMidYMid slice" />
              ) : (
                <>
                  <circle cx={p.x} cy={ay} r={ir} fill={prof?.color ?? "rgba(0,0,0,0.25)"} />
                  <text x={p.x} y={ay + ir * 0.36} textAnchor="middle" fontSize={ir * 1.05}>
                    {prof?.emoji || nameOf(p.trader).replace(/^[@0x]+/, "").slice(0, 1).toUpperCase() || "?"}
                  </text>
                </>
              )}
              {big && (
                <>
                  <text x={p.x} y={p.y + p.r * 0.42} textAnchor="middle" fontFamily="var(--font-sans)" fontWeight="700" fontSize={Math.min(15, p.r / 4.2)} fill="#fff">
                    {nameOf(p.trader).slice(0, 14)}
                  </text>
                  <text x={p.x} y={p.y + p.r * 0.66} textAnchor="middle" fontFamily="var(--font-mono)" fontWeight="600" fontSize={Math.min(14, p.r / 4.6)} fill="#fff" opacity="0.95">
                    {money(p.realized)}
                  </text>
                </>
              )}
              {p.rank < 3 && (
                <text x={p.x + p.r * 0.62} y={p.y - p.r * 0.62} textAnchor="middle" fontSize={Math.max(14, p.r / 3.4)}>
                  {["🥇", "🥈", "🥉"][p.rank]}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {sel ? (
        <div className="mt-3 rounded-2xl bg-paper p-3 flex items-center gap-3 flex-wrap">
          <Link href={profileHref(profiles.get(sel.trader) ?? { address: sel.trader as `0x${string}`, username: null })} className="flex items-center gap-3 min-w-0 flex-1">
            {profiles.get(sel.trader) ? <Avatar profile={profiles.get(sel.trader)!} size={44} /> : <span className="w-11 h-11 rounded-full bg-line shrink-0" />}
            <span className="min-w-0">
              <span className="block font-semibold truncate">
                #{sel.rank + 1} {nameOf(sel.trader)}
                {isQuickSeller(sel) && <span className="text-[0.75rem] text-ink-3 font-normal"> ⚡</span>}
                {profiles.get(sel.trader)?.allowCopy && !profiles.get(sel.trader)?.hideTrades && <CopyBadge className="ml-1.5 align-middle" />}
              </span>
              <span className="block text-[0.75rem] text-ink-3">
                <span className={"font-mono font-semibold " + (sel.realized >= 0 ? "text-up" : "text-danger")}>{money(sel.realized)}</span>
                {winRate(sel) !== null ? ` · ${Math.round((winRate(sel) ?? 0) * 100)}% win` : ""} · {sel.trades} trades
              </span>
            </span>
          </Link>
          {profiles.get(sel.trader) && (
            <span className="flex gap-2 shrink-0">
              <FollowButton profile={profiles.get(sel.trader)!} />
              <CopyButton profile={profiles.get(sel.trader)!} />
            </span>
          )}
        </div>
      ) : (
        <p className="text-[0.75rem] text-ink-3 mt-2">
          Bigger bubble, more trading. <span className="text-up font-semibold">Green</span> made money, <span className="text-danger font-semibold">red</span> lost. Tap one to see who it is.
        </p>
      )}
    </div>
  );
}
