"use client";

import { useId } from "react";

/**
 * A small price line with a soft fill: green when the price is up over the
 * window, red when down, grey when flat. Purely decorative (aria-hidden).
 */
export function Sparkline({ pts, className = "", fill = true }: { pts: number[] | null | undefined; className?: string; fill?: boolean }) {
  const gid = useId().replace(/:/g, "");
  if (!pts || pts.length < 2) return <span className={className} aria-hidden="true" />;
  const W = 100;
  const H = 32;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo;
  const flat = !(span > 0) || span / (hi || 1) < 0.0005;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, flat ? H / 2 : H - 3 - ((p - lo) / span) * (H - 6)] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const tone = flat || Math.abs(last - first) / (first || 1) < 0.001 ? "text-ink-3" : last > first ? "text-up" : "text-danger";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={"block " + tone + " " + className} aria-hidden="true" focusable="false">
      {fill && !flat && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d}L${W},${H}L0,${H}Z`} fill={`url(#${gid})`} />
        </>
      )}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
