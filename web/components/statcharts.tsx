"use client";

import { useState, type ReactNode } from "react";

/** Short money / number formats for axes and labels. */
export function short(v: number, prefix = ""): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${prefix}${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${prefix}${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${prefix}${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return `${prefix}${v.toFixed(0)}`;
  if (a >= 1) return `${prefix}${v.toFixed(2)}`;
  if (a === 0) return `${prefix}0`;
  return `${prefix}${v.toPrecision(2)}`;
}

/** Card frame shared by every stats block. */
export function Panel({ title, subtitle, right, children, className = "" }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={"rounded-3xl border border-line bg-surface p-4 sm:p-6 min-w-0 " + className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display font-bold text-[1.0625rem] sm:text-[1.1875rem]">{title}</h2>
          {subtitle && <p className="text-[0.8125rem] text-ink-3 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Tiny line for a KPI card or a chain row. */
export function Sparkline({ values, color = "var(--color-emerald)", height = 36, className = "" }: { values: number[]; color?: string; height?: number; className?: string }) {
  if (values.length < 2) return <div style={{ height }} className={className} />;
  const max = Math.max(...values, 1e-18);
  const w = 100;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 2 - (v / max) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${w},${height} L0,${height} Z`;
  const id = `sg${Math.round(values.reduce((a, b) => a + b, 0) * 1e6) % 1e9}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={"w-full " + className} style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Daily bars with a value axis, dates and a hover read-out. */
export function BarChart({
  labels,
  values,
  format,
  color = "var(--color-emerald)",
  height = 200,
  integer = false,
}: {
  labels: string[];
  values: number[];
  format: (v: number) => string;
  color?: string;
  height?: number;
  /** Counts: whole-number axis (0, 2, 4…) instead of fractions. */
  integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...values, 0);
  const top = integer ? Math.max(2, Math.ceil((max * 1.1) / 2) * 2) : max > 0 ? max * 1.1 : 1;
  const shown = hover ?? values.length - 1;
  const total = values.reduce((a, b) => a + b, 0);
  const ticks = [1, 0.5, 0];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="font-mono text-[0.75rem] text-ink-3">{labels[shown] ?? ""}</div>
        <div className="font-display font-bold text-[1.125rem] tabular-nums">{values.length ? format(values[shown] ?? 0) : "—"}</div>
      </div>
      <div className="relative" style={{ height }}>
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 flex items-center gap-2" style={{ top: `${(1 - t) * 100}%`, transform: "translateY(-50%)" }}>
            <span className="w-11 shrink-0 text-right font-mono text-[0.625rem] text-ink-3">{format(top * t)}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-[3.25rem] flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
          {values.map((v, i) => (
            <div
              key={labels[i] ?? i}
              className="flex-1 h-full flex items-end cursor-crosshair"
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
            >
              <div
                className="w-full rounded-t-[3px] transition-opacity"
                style={{
                  height: `${Math.max((v / top) * 100, v > 0 ? 1.5 : 0.6)}%`,
                  background: color,
                  opacity: hover === null || hover === i ? (v > 0 ? 1 : 0.25) : 0.35,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-between pl-[3.25rem] mt-2 font-mono text-[0.625rem] text-ink-3">
        <span>{labels[0]?.slice(5)}</span>
        <span>{labels[Math.floor(labels.length / 2)]?.slice(5)}</span>
        <span>{labels[labels.length - 1]?.slice(5)}</span>
      </div>
      <div className="mt-3 flex justify-between text-[0.75rem] text-ink-3">
        <span>Total in period</span>
        <span className="font-mono text-ink">{format(total)}</span>
      </div>
    </div>
  );
}

export type Slice = { label: string; value: number; color: string; detail?: string };

/** Ring chart with the total in the middle and a legend beside it. */
export function Donut({ slices, center, centerLabel }: { slices: Slice[]; center: string; centerLabel: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4 sm:gap-6">
      <div className="relative w-[128px] h-[128px] shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-line)" strokeWidth="11" />
          {total > 0 &&
            slices.map((s) => {
              const len = (s.value / total) * c;
              const el = (
                <circle
                  key={s.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="11"
                  strokeDasharray={`${Math.max(len - 0.8, 0)} ${c}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-display font-bold text-[1.125rem] leading-none tabular-nums">{center}</span>
          <span className="text-[0.625rem] text-ink-3 mt-1">{centerLabel}</span>
        </div>
      </div>
      <ul className="grid gap-2 min-w-0 flex-1">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[0.8125rem] min-w-0">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} aria-hidden="true" />
            <span className="truncate flex-1">{s.label}</span>
            <span className="font-mono text-ink-2 shrink-0 tabular-nums">{s.detail ?? short(s.value)}</span>
            <span className="font-mono text-ink-3 w-11 text-right shrink-0 tabular-nums">{total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
