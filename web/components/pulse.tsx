"use client";

/**
 * sasa Pulse: the whole market on one live screen, built to be watched.
 *  - <PulseDesk />  the full screen at /pulse/ (?tv=1 or the ⛶ button: edge to edge, for recordings)
 *  - <PulseStrip /> the live band at the top of Explore
 * Every number is live (lib/pulse.ts); the animation only reacts to real events (a whale trade,
 * a price tick), it never invents data.
 */
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { compactUsd } from "@/lib/format";
import { fetchBook, fetchMids, fetchPulse, fetchTape, fundingYear, type PulseBook, type PulseData } from "@/lib/pulse";
import type { PerpCandle, PerpMarket } from "@/lib/perps";
import type { WhaleMove } from "@/lib/hldata";

// ------------------------------------------------------------------ palette & helpers

const C = { or: "#ff6b1a", g: "#2ee6a0", r: "#ff4d6d", b: "#4da3ff", p: "#a66bff", pk: "#ff4fd8", y: "#ffd24d" };
type NodeKey = "whales" | "spot" | "futures" | "stocks" | "predict" | "funding" | "movers";
type PNode = { key: NodeKey; glyph: string; name: string; color: string; text: string; href: string };

const price = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const d = v >= 1000 ? 0 : v >= 100 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 4 : 6;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "pz-up" : "pz-dn");
const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const moveTag = (m: WhaleMove) =>
  m.kind === "close" ? "CLOSE" : m.kind === "cut" ? "CUT" : m.kind === "flip" ? "FLIP" : m.side === "long" ? "LONG" : "SHORT";
const moveColor = (m: WhaleMove) => (m.kind === "close" || m.kind === "cut" ? C.or : m.side === "long" ? C.g : C.r);
const coinOf = (c: string) => c.replace(/^[a-z0-9]+:/i, "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ------------------------------------------------------------------ data hook

function usePulse(lite: boolean) {
  const [data, setData] = useState<PulseData | null>(null);
  const [mids, setMids] = useState<Record<string, number>>({});
  const [now, setNow] = useState(0);
  const [fresh, setFresh] = useState<WhaleMove[]>([]);
  const seen = useRef<Set<number> | null>(null);
  const hist = useRef<Record<string, number[]>>({});
  const ticks = useRef(0);

  useEffect(() => {
    let on = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const d = await fetchPulse({ lite });
        if (!on) return;
        if (seen.current) {
          const nw = d.whales.filter((w) => !seen.current!.has(w.id));
          if (nw.length) setFresh(nw);
        }
        seen.current = new Set(d.whales.map((w) => w.id));
        setData(d);
      } catch {
        /* keep the last good data */
      }
    };
    const loadMids = async () => {
      if (document.hidden) return;
      try {
        const m = await fetchMids();
        if (!on) return;
        for (const k of ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB", "SUI"]) {
          if (!m[k]) continue;
          const h = (hist.current[k] ??= []);
          h.push(m[k]);
          if (h.length > 120) h.shift();
        }
        ticks.current++;
        setMids(m);
      } catch {
        /* next tick */
      }
    };
    load();
    loadMids();
    const a = setInterval(load, lite ? 20_000 : 12_000);
    const b = setInterval(loadMids, lite ? 6_000 : 3_000);
    setNow(Date.now());
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      on = false;
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, [lite]);

  return { data, mids, now, fresh, hist: hist.current };
}

/** The halo's nodes: each one a live number. */
function nodesOf(d: PulseData | null, lite: boolean): PNode[] {
  const list: PNode[] = [];
  const w = d?.whales[0];
  list.push({ key: "whales", glyph: "W", name: "WHALES", color: C.or, href: "/data/", text: w ? `${coinOf(w.coin)} ${moveTag(w)} ${compactUsd(w.usd)}` : "watching…" });
  const g = d?.top.length
    ? d.top.slice().sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0]
    : null;
  if (!lite) list.push({ key: "spot", glyph: "S", name: "SPOT", color: C.g, href: "/market/", text: g ? `${g.symbol.toUpperCase()} ${pct(g.change24h, 1)}` : "500 coins" });
  list.push({ key: "futures", glyph: "F", name: "FUTURES", color: C.b, href: "/futures/", text: d ? `OI ${compactUsd(d.openInterest)}` : "…" });
  if (!lite) {
    const s = d?.stocks[0];
    list.push({ key: "stocks", glyph: "$", name: "STOCKS", color: C.y, href: "/futures/", text: s ? `${s.label} ${pct(s.change24h)}` : "24/7" });
  }
  const o = d?.odds[0];
  list.push({ key: "predict", glyph: "P", name: "PREDICT", color: C.p, href: "/predict/", text: o ? `${clip(o.title, 22)} ${Math.round(o.yes * 100)}¢` : "live odds" });
  const hot = d?.crypto.slice(0, 30).sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))[0];
  list.push({ key: "funding", glyph: "%", name: "FUNDING", color: C.pk, href: "/data/", text: hot ? `${hot.label} ${pct(fundingYear(hot.funding), 0)}/yr` : "…" });
  const mv = d?.crypto.filter((m) => m.volume24h > 5e6 && m.change24h !== null).sort((a, b) => Math.abs(b.change24h!) - Math.abs(a.change24h!))[0];
  list.push({ key: "movers", glyph: "M", name: "MOVER", color: C.r, href: "/futures/", text: mv ? `${mv.label} ${pct(mv.change24h, 1)}` : "…" });
  return list;
}

// ------------------------------------------------------------------ the reactor (canvas)

type Burst = { key: NodeKey; n: number };

function Reactor({ nodes, bursts, compact }: { nodes: PNode[]; bursts: Burst[]; compact?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chipRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const nodesRef = useRef(nodes);
  const queue = useRef<Burst[]>([]);
  nodesRef.current = nodes;

  useEffect(() => {
    queue.current.push(...bursts);
  }, [bursts]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let seed = 7;
    const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let W = 0, H = 0, dpr = 1, small = false;
    const size = () => {
      small = cv.clientWidth < 700;
      dpr = Math.min(window.devicePixelRatio || 1, small ? 2 : 1.5);
      W = cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
      H = cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    const NS = small ? 70 : 140;
    const strands = Array.from({ length: NS }, () => ({ w: 0.6 + R() * 1.6, dr: R() - 0.5, tilt: (R() - 0.5) * 0.5, ph: R() * 6.28, sp: 0.1 + R() * 0.25 }));
    const stars = Array.from({ length: small ? 70 : 150 }, () => [R(), R(), R()]);
    const parts: { i: number; t: number; sp: number; o: number; big: boolean }[] = [];
    const glow: number[] = [];
    const ST = [[255, 107, 26], [255, 79, 216], [166, 107, 255], [77, 163, 255], [46, 230, 160], [255, 210, 77], [255, 107, 26]];
    const hue = (t: number) => {
      t = (((t % 1) + 1) % 1) * 6;
      const i = t | 0, f = t - i, a = ST[i], b = ST[i + 1];
      return `${(a[0] + (b[0] - a[0]) * f) | 0},${(a[1] + (b[1] - a[1]) * f) | 0},${(a[2] + (b[2] - a[2]) * f) | 0}`;
    };
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(cv);
    let raf = 0;
    const draw = (T: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible || document.hidden) return;
      if (reduce) T = T * 0.15;
      const ns = nodesRef.current;
      const cx = W / 2, cy = H * (compact ? (small ? 0.42 : 0.5) : 0.55);
      const S = Math.min(W * (small ? 0.98 : 0.85), H * (compact ? 1.75 : 1.55)) / 2;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#07070b";
      ctx.fillRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 1.3);
      bg.addColorStop(0, "rgba(255,107,26,.16)");
      bg.addColorStop(0.5, "rgba(120,40,160,.07)");
      bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,.035)";
      ctx.lineWidth = 1;
      const step = 40 * dpr;
      ctx.beginPath();
      for (let x = 0; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      for (const s of stars) {
        ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.4 * Math.abs(Math.sin(T * 0.001 + s[2] * 9))})`;
        ctx.fillRect(s[0] * W, s[1] * H, 1.6 * dpr, 1.6 * dpr);
      }
      ctx.globalCompositeOperation = "lighter";
      const rx = S * 0.78, ry = S * 0.4;
      strands.forEach((st, k) => {
        ctx.beginPath();
        const off = st.dr * S * 0.13;
        for (let i = 0; i <= 96; i++) {
          const t = (i / 96) * 6.2832;
          const wob = Math.sin(t * 3 + st.ph + T * 0.0024 * st.sp) * S * 0.05 * st.w;
          const x = cx + Math.cos(t) * (rx + off + wob);
          const y = cy + Math.sin(t) * (ry + off * 0.5 + wob * 0.6) + Math.cos(t) * st.tilt * S * 0.12;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        const g = ctx.createLinearGradient(cx - rx, cy, cx + rx, cy);
        const h0 = k / NS + T * 0.00004;
        g.addColorStop(0, `rgba(${hue(h0)},.22)`);
        g.addColorStop(0.5, `rgba(${hue(h0 + 0.33)},.22)`);
        g.addColorStop(1, `rgba(${hue(h0 + 0.66)},.22)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = st.w * 1.4 * dpr;
        ctx.stroke();
      });
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, S * (0.36 + i * 0.05), S * (0.19 + i * 0.025), 0, 0, 6.283);
        ctx.strokeStyle = `rgba(77,163,255,${0.18 - i * 0.04})`;
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
      }
      const pos = ns.map((_, i) => {
        const a = (i / ns.length) * 6.283 + T * 0.00012 - 1.2;
        return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, a];
      });
      // real events: a burst of light from that node into the core
      while (queue.current.length) {
        const b = queue.current.shift()!;
        const i = ns.findIndex((n) => n.key === b.key);
        if (i < 0) continue;
        glow[i] = 1;
        for (let k = 0; k < Math.min(60, 10 + b.n * 8); k++) parts.push({ i, t: R() * 0.15, sp: 0.006 + R() * 0.012, o: (R() - 0.5) * S * 0.14, big: true });
      }
      if (parts.length < (small ? 90 : 180) && R() < 0.5) parts.push({ i: (R() * ns.length) | 0, t: 0, sp: 0.004 + R() * 0.008, o: (R() - 0.5) * S * 0.1, big: false });
      pos.forEach((p, i) => {
        const gl = glow[i] ?? 0;
        if (i % 2 && gl < 0.05) return;
        const g = ctx.createLinearGradient(p[0], p[1], cx, cy);
        g.addColorStop(0, ns[i].color + (gl > 0.05 ? "ff" : "aa"));
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = (2 + gl * 4) * dpr;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.quadraticCurveTo((p[0] + cx) / 2, (p[1] + cy) / 2 - S * 0.25, cx, cy);
        ctx.stroke();
      });
      for (let k = parts.length - 1; k >= 0; k--) {
        const p = parts[k];
        p.t += p.sp;
        if (p.t >= 1 || !pos[p.i]) { parts.splice(k, 1); continue; }
        const q = pos[p.i];
        const x = q[0] + (cx - q[0]) * p.t + p.o * Math.sin(p.t * 3);
        const y = q[1] + (cy - q[1]) * p.t - Math.sin(p.t * 3.14) * S * 0.18;
        ctx.fillStyle = ns[p.i].color;
        ctx.globalAlpha = 1 - p.t;
        ctx.beginPath();
        ctx.arc(x, y, (p.big ? 3.2 : 2.1) * dpr, 0, 6.28);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
      const kick = Math.max(0, ...glow.filter((x) => x !== undefined));
      const cr = S * 0.17 * (1 + Math.sin(T * 0.003) * 0.03 + kick * 0.06);
      const halo = ctx.createRadialGradient(cx, cy, cr * 0.6, cx, cy, cr * 2.6);
      halo.addColorStop(0, `rgba(255,140,60,${0.5 + kick * 0.3})`);
      halo.addColorStop(1, "rgba(255,107,26,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 2.6, 0, 6.28);
      ctx.fill();
      const og = ctx.createRadialGradient(cx - cr * 0.35, cy - cr * 0.4, cr * 0.1, cx, cy, cr);
      og.addColorStop(0, "#fff1e2");
      og.addColorStop(0.35, "#ffa04d");
      og.addColorStop(0.8, "#ff6b1a");
      og.addColorStop(1, "#9a3000");
      ctx.fillStyle = og;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, 6.28);
      ctx.fill();
      ctx.fillStyle = "#1a0800";
      ctx.font = `800 ${cr * 0.62}px Sora, Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("sasa", cx, cy + cr * 0.04);
      pos.forEach((p, i) => {
        const n = ns[i], r = S * (small ? 0.075 : 0.058), gl = glow[i] ?? 0;
        const gg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * (2.6 + gl * 2));
        gg.addColorStop(0, n.color + "aa");
        gg.addColorStop(1, n.color + "00");
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * (2.6 + gl * 2), 0, 6.28);
        ctx.fill();
        const ng = ctx.createRadialGradient(p[0] - r * 0.3, p[1] - r * 0.35, 1, p[0], p[1], r);
        ng.addColorStop(0, "#ffffff");
        ng.addColorStop(0.3, n.color);
        ng.addColorStop(1, n.color);
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * (1 + gl * 0.25), 0, 6.28);
        ctx.fill();
        ctx.fillStyle = "#0a0a10";
        ctx.font = `800 ${r * 0.85}px Sora, Inter, system-ui, sans-serif`;
        ctx.fillText(n.glyph, p[0], p[1] + 1);
        ctx.strokeStyle = n.color;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * 1.35 + Math.sin(T * 0.004 + i) * 3 * dpr + gl * r, 0, 6.28);
        ctx.stroke();
        ctx.globalAlpha = 1;
        glow[i] = gl * 0.965;
        const chip = chipRefs.current[i];
        if (chip) {
          const right = Math.cos(p[2]) > 0;
          const x = p[0] / dpr, y = p[1] / dpr, off = r / dpr + 12;
          const cw = chip.offsetWidth, maxX = W / dpr - cw - 6;
          const left = right ? Math.min(x + off, maxX) : Math.max(6, x - off - cw);
          chip.style.transform = `translate(${left}px, ${Math.max(26, y - 16)}px)`;
          chip.style.boxShadow = gl > 0.1 ? `0 0 ${10 + gl * 30}px ${n.color}` : "";
        }
      });
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [compact]);

  return (
    <>
      <canvas ref={ref} className="pz-canvas" aria-hidden="true" />
      <div className="pz-chips">
        {nodes.map((n, i) => (
          <Link key={n.key} href={n.href} ref={(el) => { chipRefs.current[i] = el; }} className="pz-chip" style={{ ["--c" as string]: n.color }}>
            <small>{n.name}</small>
            {n.text}
          </Link>
        ))}
      </div>
    </>
  );
}

/** Real events → bursts: every new whale move, and price ticks on the busiest markets. */
function useBursts(fresh: WhaleMove[], mids: Record<string, number>) {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const last = useRef<Record<string, number>>({});
  useEffect(() => {
    if (fresh.length) setBursts(fresh.map((w) => ({ key: "whales" as NodeKey, n: Math.min(5, Math.max(1, Math.round(Math.log10(Math.max(w.usd, 1e4)) - 3))) })));
  }, [fresh]);
  useEffect(() => {
    const out: Burst[] = [];
    let moved = 0;
    for (const k of ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "SUI", "HYPE"]) {
      const v = mids[k], p = last.current[k];
      if (v && p && Math.abs(v / p - 1) > 0.0004) moved++;
      if (v) last.current[k] = v;
    }
    if (moved) out.push({ key: "futures", n: moved }, { key: "movers", n: 1 });
    if (moved > 2) out.push({ key: "spot", n: 2 }, { key: "funding", n: 1 });
    if (out.length) setBursts(out);
  }, [mids]);
  return bursts;
}

// ------------------------------------------------------------------ small pieces

function Spark({ pts, up }: { pts: number[] | null | undefined; up: boolean }) {
  if (!pts || pts.length < 3) return <span className="pz-spark" />;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(" ");
  const col = up ? C.g : C.r;
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="pz-spark" aria-hidden="true">
      <polygon points={`0,30 ${d} 100,30`} fill={col} opacity=".14" />
      <polyline points={d} fill="none" stroke={col} strokeWidth="1.6" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 3px ${col})` }} />
    </svg>
  );
}

function Tape({ candles }: { candles: PerpCandle[] }) {
  if (candles.length < 5) return <div className="pz-wait">loading…</div>;
  const cs = candles.slice(-70);
  const lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high)), span = hi - lo || 1;
  const vmax = Math.max(...cs.map((c) => c.volume)) || 1;
  const y = (v: number) => 4 + (1 - (v - lo) / span) * 76;
  const w = 100 / cs.length;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pz-tape" aria-label="BTC one-minute candles">
      {cs.map((c, i) => {
        const up = c.close >= c.open, col = up ? C.g : C.r, x = i * w;
        return (
          <g key={c.t}>
            <line x1={x + w / 2} x2={x + w / 2} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <rect x={x + w * 0.15} width={w * 0.7} y={Math.min(y(c.open), y(c.close))} height={Math.max(0.6, Math.abs(y(c.open) - y(c.close)))} fill={col} />
            <rect x={x + w * 0.15} width={w * 0.7} y={100 - (c.volume / vmax) * 14} height={(c.volume / vmax) * 14} fill={col} opacity=".35" />
          </g>
        );
      })}
    </svg>
  );
}

function Book({ book, mid }: { book: PulseBook | null; mid: number | undefined }) {
  if (!book) return <div className="pz-book" />;
  const max = Math.max(...book.asks.map((a) => a[1]), ...book.bids.map((b) => b[1]), 1e-9);
  const row = (l: [number, number], col: string) => (
    <div key={col + l[0]} className="pz-bk" style={{ color: col }}>
      <span>{l[0].toLocaleString("en-US")}</span>
      <span>{l[1].toFixed(2)}</span>
      <i style={{ width: `${(l[1] / max) * 100}%`, background: col }} />
    </div>
  );
  return (
    <div className="pz-book pz-mono">
      {book.asks.slice(0, 7).reverse().map((a) => row(a, C.r))}
      <div className="pz-bkmid">{mid ? mid.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—"}</div>
      {book.bids.slice(0, 7).map((b) => row(b, C.g))}
    </div>
  );
}

function Clock({ now }: { now: number }) {
  if (!now) return <span className="pz-clock pz-mono">--:--:--</span>;
  const d = new Date(now);
  return <span className="pz-clock pz-mono">{d.toISOString().slice(11, 19)} <small>UTC</small></span>;
}

// ------------------------------------------------------------------ full screen

export function PulseDesk() {
  const { data, mids, now, fresh, hist } = usePulse(false);
  const nodes = useMemo(() => nodesOf(data, false), [data]);
  const bursts = useBursts(fresh, mids);
  const [tv, setTv] = useState(false);
  const [candles, setCandles] = useState<PerpCandle[]>([]);
  const [book, setBook] = useState<PulseBook | null>(null);

  useEffect(() => {
    if (/[?&]tv=1/.test(window.location.search)) setTv(true);
  }, []);
  useEffect(() => {
    let on = true;
    const t = () => !document.hidden && fetchTape("BTC").then((c) => on && setCandles(c)).catch(() => {});
    const b = () => !document.hidden && fetchBook("BTC").then((x) => on && setBook(x)).catch(() => {});
    t();
    b();
    const a1 = setInterval(t, 15_000), a2 = setInterval(b, 2_500);
    return () => { on = false; clearInterval(a1); clearInterval(a2); };
  }, []);
  useEffect(() => {
    document.documentElement.style.overflow = tv ? "hidden" : "";
    return () => { document.documentElement.style.overflow = ""; };
  }, [tv]);

  const d = data;
  const btc = d?.crypto.find((m) => m.coin === "BTC");
  const btcNow = mids.BTC ?? btc?.mark;
  const btcChg = btc && btcNow && btc.prevDay ? (btcNow / btc.prevDay - 1) * 100 : btc?.change24h ?? null;
  const live = !!d && now - d.at < 90_000;
  const hot = new Set(fresh.length ? ["whales"] : []);

  const sparkOf = (sym: string) => d?.top.find((c) => c.symbol.toUpperCase() === sym)?.spark ?? hist[sym];
  const feed: { label: string; sub: string; px: number | undefined; chg: number | null; pts: number[] | null | undefined }[] = [];
  for (const k of ["BTC", "ETH", "SOL", "XRP", "DOGE"]) {
    const m = d?.crypto.find((x) => x.coin === k);
    if (m) feed.push({ label: k, sub: "Futures · spot", px: mids[k] ?? m.mark, chg: m.prevDay ? ((mids[k] ?? m.mark) / m.prevDay - 1) * 100 : m.change24h, pts: sparkOf(k) });
  }
  for (const s of (d?.stocks ?? []).slice(0, 2)) feed.push({ label: s.label, sub: s.name ?? s.group, px: s.mark, chg: s.change24h, pts: null });

  const gainers = (d?.top ?? []).slice().sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0)).slice(0, 8);
  const losers = (d?.top ?? []).slice().sort((a, b) => (a.change24h ?? 0) - (b.change24h ?? 0)).slice(0, 8);
  const heat = (d?.crypto ?? []).slice(0, 12);

  const agents: { key: NodeKey; glyph: string; name: string; color: string; top: string; sub: string }[] = [
    { key: "whales", glyph: "W", name: "WHALES", color: C.or, top: d ? `${d.whales1h} moves` : "…", sub: "last hour" },
    { key: "spot", glyph: "S", name: "SPOT", color: C.g, top: d?.top.length ? `${d.top.length} coins` : "500 coins", sub: btcChg !== null ? `BTC ${pct(btcChg, 1)}` : "" },
    { key: "futures", glyph: "F", name: "FUTURES", color: C.b, top: d ? `${compactUsd(d.openInterest)} OI` : "…", sub: d ? `${compactUsd(d.vol24h)} 24h` : "" },
    { key: "stocks", glyph: "$", name: "STOCKS", color: C.y, top: d?.stocks[0] ? `${d.stocks[0].label} ${pct(d.stocks[0].change24h, 1)}` : "…", sub: d ? `${d.stocks.length} markets · 24/7` : "" },
    { key: "predict", glyph: "P", name: "PREDICT", color: C.p, top: d ? `${d.odds.length ? "live odds" : "…"}` : "…", sub: "prices, matches, rates" },
    { key: "funding", glyph: "%", name: "FUNDING", color: C.pk, top: d ? `${pct(fundingYear(d.avgFunding), 1)}/yr` : "…", sub: "top 50 average" },
    { key: "movers", glyph: "M", name: "FEAR / GREED", color: C.r, top: d?.fg ? `${d.fg.score} · ${d.fg.label}` : "…", sub: "live market mood" },
  ];

  const wire: string[] = [];
  for (const w of (d?.whales ?? []).slice(0, 6)) wire.push(`🐋 WHALE ${moveTag(w)} ${coinOf(w.coin)} ${compactUsd(w.usd)}${w.lev ? ` ${Math.round(w.lev)}x` : ""}`);
  if (gainers[0]) wire.push(`${gainers[0].symbol.toUpperCase()} ${pct(gainers[0].change24h, 1)} today`);
  if (losers[0]) wire.push(`${losers[0].symbol.toUpperCase()} ${pct(losers[0].change24h, 1)} today`);
  for (const o of (d?.odds ?? []).slice(0, 2)) wire.push(`PREDICT · ${clip(o.title, 40)} → ${Math.round(o.yes * 100)}¢`);
  if (d?.stocks[0]) wire.push(`${d.stocks[0].label} ${pct(d.stocks[0].change24h)} · 24/7`);

  const page = (
    <div className={`pz pz-desk ${tv ? "pz-tv" : ""}`}>
      <style>{CSS}</style>
      <div className="pz-panel pz-top">
        <Link href="/explore/" className="pz-logo"><i />sasa <span>PULSE</span></Link>
        <div className="pz-stats">
          <div className="pz-st"><small>24H VOLUME</small><b className="pz-mono">{d ? compactUsd(d.vol24h) : "…"}</b></div>
          <div className="pz-st"><small>WHALE MOVES / 1H</small><b className="pz-mono" style={{ color: C.or }}>{d ? d.whales1h : "…"}</b></div>
          <div className="pz-st"><small>OPEN INTEREST</small><b className="pz-mono">{d ? compactUsd(d.openInterest) : "…"}</b></div>
          <Clock now={now} />
          <span className={`pz-live ${live ? "" : "pz-off"}`}>● {live ? "LIVE" : "SYNC"}</span>
          <button className="pz-fs" onClick={() => setTv(!tv)} aria-label={tv ? "Exit full screen" : "Full screen"}>{tv ? "✕" : "⛶"}</button>
        </div>
      </div>

      <div className="pz-panel pz-tick">
        <div className="pz-lab">LIVE WIRE</div>
        <div className="pz-railwrap"><div className="pz-rail pz-mono">{[...wire, ...wire].map((w, i) => <span key={i}>{w}</span>)}</div></div>
      </div>

      <div className="pz-agents">
        {agents.map((a, i) => (
          <div key={a.key + i} className={`pz-panel pz-ag ${hot.has(a.key) ? "pz-hot" : ""}`} style={{ ["--c" as string]: a.color }}>
            <div className="pz-ic" style={{ background: a.color, boxShadow: `0 0 14px ${a.color}` }}>{a.glyph}</div>
            <div className="pz-agt"><small>{String(i + 1).padStart(2, "0")} · {a.top}</small><b>{a.name}</b><em>{a.sub}</em></div>
          </div>
        ))}
      </div>

      <div className="pz-main">
        <div className="pz-panel pz-feedp">
          <div className="pz-ph"><span className="pz-dot" /><b>Market feed</b><span className="pz-r">{d?.top.length ? `${d.top.length} COINS` : "LIVE"}</span></div>
          <div className="pz-feed">
            {feed.map((f) => (
              <Link href={`/futures/?c=${f.label}`} key={f.label} className="pz-fc">
                <div><b>{f.label}</b><small>{f.sub}</small></div>
                <Spark pts={f.pts} up={(f.chg ?? 0) >= 0} />
                <div className="pz-v pz-mono">{price(f.px)}<i className={tone(f.chg)}>{pct(f.chg)}</i></div>
              </Link>
            ))}
            {!feed.length && <div className="pz-wait">loading…</div>}
          </div>
        </div>

        <div className="pz-panel pz-reactor">
          <Reactor nodes={nodes} bursts={bursts} />
          <div className="pz-ph pz-over"><span className="pz-dot" /><b>The Pulse</b>&nbsp;· every whale, every tick, live</div>
          <div className="pz-big"><small>BTC</small><b className="pz-mono">{price(btcNow)}</b><i className={`pz-mono ${tone(btcChg)}`}>{pct(btcChg)}</i></div>
          <div className="pz-big2"><small>FEAR / GREED</small><b className="pz-mono">{d?.fg?.score ?? "—"}</b><i>{d?.fg?.label ?? ""}</i></div>
          <div className="pz-hud pz-mono">
            <div><small>WHALES LONG</small><b className={d?.longShare != null ? (d.longShare >= 0.5 ? "pz-up" : "pz-dn") : ""}>{d?.longShare != null ? `${Math.round(d.longShare * 100)}%` : "—"}</b></div>
            <div><small>AVG FUNDING</small><b>{d ? `${pct(fundingYear(d.avgFunding), 1)}/yr` : "—"}</b></div>
            <div><small>BIGGEST WHALE 1H</small><b style={{ color: C.or }}>{d?.biggest1h ? `${compactUsd(d.biggest1h.usd)} ${coinOf(d.biggest1h.coin)}` : "—"}</b></div>
          </div>
        </div>

        <div className="pz-panel pz-side">
          <div className="pz-ph"><span className="pz-dot" style={{ background: C.or, boxShadow: `0 0 8px ${C.or}` }} /><b>Whale stream</b><span className="pz-r">TOP TRADERS</span></div>
          <div className="pz-ws">
            {(d?.whales ?? []).slice(0, 8).map((w) => (
              <Link key={w.id} href={`/data/whale/?a=${w.address}`} className={`pz-w ${fresh.some((f) => f.id === w.id) ? "pz-new" : ""}`} style={{ ["--c" as string]: moveColor(w) }}>
                <div className="pz-t">{moveTag(w)}<small>{ago(w.t, now)}</small></div>
                <div className="pz-wc"><b>{coinOf(w.coin)}</b><small>{w.lev ? `${Math.round(w.lev)}x · ` : ""}{w.name ?? (w.rank ? `Whale #${w.rank}` : short(w.address))}</small></div>
                <div className="pz-amt pz-mono">{compactUsd(w.usd)}<i>{price(w.px)}</i></div>
              </Link>
            ))}
            {d && !d.whales.length && <div className="pz-wait">No whale moves right now.</div>}
          </div>
          {d?.longShare != null && (
            <div className="pz-ls">
              <div className="pz-lsb"><div style={{ width: `${d.longShare * 100}%` }} /></div>
              <div className="pz-lsl pz-mono"><span className="pz-up">LONG {Math.round(d.longShare * 100)}%</span><span>whale money in</span><span className="pz-dn">{100 - Math.round(d.longShare * 100)}% SHORT</span></div>
            </div>
          )}
        </div>
      </div>

      <div className="pz-bot">
        <div className="pz-panel">
          <div className="pz-ph"><b>Gainers / Losers</b><span className="pz-r">24H · TOP 500</span></div>
          <div className="pz-gl pz-mono">
            <section>{gainers.map((c) => <Link key={c.id} href={`/m/?id=${encodeURIComponent(c.id)}`}><span>{c.symbol.toUpperCase()}</span><span className="pz-up">{pct(c.change24h, 1)}</span></Link>)}</section>
            <section>{losers.map((c) => <Link key={c.id} href={`/m/?id=${encodeURIComponent(c.id)}`}><span>{c.symbol.toUpperCase()}</span><span className="pz-dn">{pct(c.change24h, 1)}</span></Link>)}</section>
          </div>
        </div>
        <div className="pz-panel pz-tapep">
          <div className="pz-ph"><b>The Tape</b>&nbsp;· BTC 1m<span className="pz-r">LIVE BOOK</span></div>
          <div className="pz-tapebody"><Tape candles={candles} /><Book book={book} mid={mids.BTC} /></div>
        </div>
        <div className="pz-panel">
          <div className="pz-ph"><b>Predict</b><span className="pz-r">LIVE ODDS</span></div>
          <div className="pz-pm">
            {(d?.odds ?? []).slice(0, 4).map((o) => {
              const y = Math.round(o.yes * 100);
              return (
                <Link key={o.id} href="/predict/" className="pz-pq">
                  {clip(o.title, 54)}
                  <div className="pz-bar pz-mono"><div style={{ width: `${Math.max(y, 14)}%` }} className="pz-yes">YES {y}¢</div><div className="pz-no">NO {100 - y}¢</div></div>
                </Link>
              );
            })}
            {d && !d.odds.length && <div className="pz-wait">No open markets right now.</div>}
          </div>
        </div>
        <div className="pz-panel">
          <div className="pz-ph"><b>Funding heat</b><span className="pz-r">% A YEAR</span></div>
          <div className="pz-hm pz-mono">
            {heat.map((m: PerpMarket) => {
              const y = fundingYear(m.funding), a = Math.min(1, Math.abs(y) / 40);
              return (
                <Link key={m.coin} href={`/futures/?c=${m.coin}`} style={{ background: y >= 0 ? `rgba(46,230,160,${0.1 + a * 0.5})` : `rgba(255,77,109,${0.1 + a * 0.5})` }}>
                  {m.label}<small>{pct(y, 1)}</small>
                </Link>
              );
            })}
          </div>
          <div className="pz-liq pz-mono">
            <div><small>LONGS PAY</small><b className="pz-up">{heat.filter((m) => m.funding > 0).length}/{heat.length}</b></div>
            <div><small>SHORTS PAY</small><b className="pz-dn">{heat.filter((m) => m.funding < 0).length}/{heat.length}</b></div>
          </div>
        </div>
      </div>
      <p className="pz-note">Live data from sasa&apos;s Market, Futures, Predict and Data tabs. Not financial advice.</p>
    </div>
  );
  // edge to edge: on top of the site's header and menus
  return tv ? createPortal(page, document.body) : page;
}

// ------------------------------------------------------------------ Explore strip

export function PulseStrip() {
  const { data, mids, fresh } = usePulse(true);
  const nodes = useMemo(() => nodesOf(data, true), [data]);
  const bursts = useBursts(fresh, mids);
  const btc = data?.crypto.find((m) => m.coin === "BTC");
  const btcNow = mids.BTC ?? btc?.mark;
  const chg = btc && btcNow && btc.prevDay ? (btcNow / btc.prevDay - 1) * 100 : null;
  const w = fresh[0] ?? data?.whales[0];
  return (
    <div className="pz pz-strip">
      <style>{CSS}</style>
      <Reactor nodes={nodes} bursts={bursts} compact />
      <div className="pz-big"><small>BTC</small><b className="pz-mono">{price(btcNow)}</b><i className={`pz-mono ${tone(chg)}`}>{pct(chg)}</i></div>
      <div className="pz-big2"><small>FEAR / GREED</small><b className="pz-mono">{data?.fg?.score ?? "—"}</b><i>{data?.fg?.label ?? ""}</i></div>
      <div className="pz-badge">NEW · sasa PULSE</div>
      {w && (
        <Link href={`/data/whale/?a=${w.address}`} className="pz-wire pz-mono" style={{ ["--c" as string]: moveColor(w) }}>
          🐋 <b>WHALE {moveTag(w)} {coinOf(w.coin)} {compactUsd(w.usd)}</b>{w.lev ? ` · ${Math.round(w.lev)}x` : ""}
        </Link>
      )}
      <Link href="/pulse/" className="pz-cta">Open sasa Pulse →</Link>
    </div>
  );
}

// ------------------------------------------------------------------ styles (always dark)

const CSS = `
.pz{--bg:#07070b;--line:#1d1d2a;--txt:#e9e9f2;--mut:#7b7b92;color:var(--txt);font-family:var(--font-sans)}
.pz *{box-sizing:border-box}
.pz a{color:inherit;text-decoration:none}
.pz-mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.pz-up{color:#2ee6a0}.pz-dn{color:#ff4d6d}
.pz-panel{background:linear-gradient(180deg,#0f0f18,#0a0a10);border:1px solid var(--line);border-radius:10px;position:relative;overflow:hidden;min-width:0}
.pz-ph{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);padding:8px 10px 4px;font-weight:700;white-space:nowrap}
.pz-ph b{color:var(--txt)}.pz-ph .pz-r{margin-left:auto;color:#ff6b1a}
.pz-over{position:absolute;left:0;right:0;top:0;z-index:2;pointer-events:none}
.pz-dot{width:6px;height:6px;border-radius:50%;background:#2ee6a0;box-shadow:0 0 8px #2ee6a0;flex:none}
.pz-wait{color:var(--mut);font-size:12px;padding:10px}
.pz-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.pz-chips{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.pz-chip{position:absolute;left:0;top:0;pointer-events:auto;background:#0a0a12e6;border:1px solid var(--c);border-radius:7px;padding:4px 9px;font-size:10.5px;white-space:nowrap;font-family:"IBM Plex Mono",ui-monospace,monospace;transition:box-shadow .3s;will-change:transform}
.pz-chip small{display:block;font-size:8.5px;letter-spacing:.12em;color:var(--c);font-weight:700}
.pz-big,.pz-big2{position:absolute;top:30px;z-index:2;pointer-events:none}
.pz-big{left:14px}.pz-big2{right:14px;text-align:right}
.pz-big small,.pz-big2 small{font-size:9px;color:var(--mut);letter-spacing:.14em;font-weight:700}
.pz-big b,.pz-big2 b{display:block;font-size:26px;font-weight:700;line-height:1.15}
.pz-big2 b{color:#ff6b1a}.pz-big i,.pz-big2 i{font-style:normal;font-size:11px;color:var(--mut)}.pz-big i.pz-up{color:#2ee6a0}.pz-big i.pz-dn{color:#ff4d6d}

/* full screen */
.pz-desk{background:var(--bg);display:grid;grid-template-rows:52px 28px 66px minmax(420px,1fr) 236px auto;gap:6px;padding:6px;height:calc(100dvh - 64px);min-height:760px}
.pz-tv{position:fixed;inset:0;z-index:1000;height:100dvh;min-height:0}
.pz-top{display:flex;align-items:center;gap:22px;padding:0 14px}
.pz-logo{display:flex;align-items:center;gap:9px;font-family:var(--font-display);font-weight:800;font-size:19px;letter-spacing:-.02em}
.pz-logo i{width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffd2a8,#ff6b1a 45%,#a63600);box-shadow:0 0 16px #ff6b1a}
.pz-logo span{color:#ff6b1a;font-size:11px;letter-spacing:.3em;margin-left:2px}
.pz-stats{margin-left:auto;display:flex;gap:22px;align-items:center}
.pz-st{text-align:right}.pz-st small{display:block;font-size:9px;letter-spacing:.14em;color:var(--mut);font-weight:700}.pz-st b{font-size:15px}
.pz-clock{font-size:22px;font-weight:700}.pz-clock small{font-size:10px;color:var(--mut)}
.pz-live{font-size:10px;font-weight:800;letter-spacing:.16em;color:#2ee6a0;border:1px solid #1d5a44;background:#08201a;padding:6px 10px;border-radius:6px;white-space:nowrap}
.pz-live.pz-off{color:#ffd24d;border-color:#5a4a1d;background:#201a08}
.pz-fs{background:#14141f;border:1px solid var(--line);color:var(--txt);border-radius:6px;width:32px;height:30px;cursor:pointer;font-size:14px}
.pz-tick{display:flex;align-items:stretch;font-size:11px;white-space:nowrap}
.pz-lab{background:#ff6b1a;color:#000;font-weight:800;letter-spacing:.14em;padding:0 10px;display:flex;align-items:center;font-size:10px;flex:none;z-index:1}
.pz-railwrap{overflow:hidden;flex:1;display:flex;align-items:center}
.pz-rail{display:flex;gap:30px;padding-left:16px;animation:pz-mv 60s linear infinite;width:max-content}
@keyframes pz-mv{to{transform:translateX(-50%)}}
.pz-agents{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;min-width:0}
.pz-ag{display:flex;align-items:center;gap:10px;padding:0 12px}
.pz-ic{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-size:15px;font-weight:800;color:#000;flex:none}
.pz-agt{min-width:0}.pz-agt small{font-size:9px;letter-spacing:.1em;color:var(--mut);font-weight:700;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pz-agt b{font-size:13px;letter-spacing:.04em;white-space:nowrap}.pz-agt em{font-style:normal;font-size:10.5px;color:var(--mut);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pz-hot{box-shadow:inset 0 -2px 0 var(--c),0 0 24px -8px var(--c)}
.pz-main{display:grid;grid-template-columns:300px minmax(0,1fr) 330px;gap:6px;min-height:0}
.pz-feed{display:flex;flex-direction:column;gap:5px;padding:4px 6px 6px;height:calc(100% - 28px)}
.pz-fc{display:grid;grid-template-columns:70px 1fr 82px;align-items:center;gap:6px;background:#0b0b12;border:1px solid #171724;border-radius:8px;padding:5px 8px;flex:1;min-height:0}
.pz-fc:hover{border-color:#3a2414}
.pz-fc b{font-size:12px}.pz-fc small{font-size:9px;color:var(--mut);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pz-v{text-align:right;font-size:11.5px}.pz-v i{font-style:normal;display:block;font-size:10px}
.pz-spark{width:100%;height:30px;display:block}
.pz-reactor{min-height:0}
.pz-hud{position:absolute;left:0;right:0;top:30px;display:flex;justify-content:center;gap:6px;z-index:2;pointer-events:none}
.pz-hud div{background:#0a0a12cc;border:1px solid var(--line);border-radius:7px;padding:5px 12px;text-align:center}
.pz-hud small{display:block;font-size:8.5px;letter-spacing:.14em;color:var(--mut);font-weight:700}.pz-hud b{font-size:13px}
.pz-side{display:flex;flex-direction:column}
.pz-ws{padding:2px 8px 6px;display:flex;flex-direction:column;gap:4px;flex:1;min-height:0;overflow:hidden}
.pz-w{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:8px;align-items:center;background:#0b0b12;border:1px solid #171724;border-left:3px solid var(--c);border-radius:7px;padding:6px 8px;font-size:11.5px}
.pz-w:hover{background:#11111b}
.pz-new{animation:pz-in .9s ease-out}
@keyframes pz-in{0%{transform:translateX(30px);box-shadow:0 0 30px var(--c);opacity:0}100%{transform:none;opacity:1}}
.pz-t{font-size:9px;font-weight:800;letter-spacing:.1em;color:var(--c)}
.pz-w small{color:var(--mut);font-size:10px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pz-wc{min-width:0}
.pz-amt{text-align:right;font-weight:700}.pz-amt i{display:block;font-style:normal;font-size:10px;color:var(--mut);font-weight:500}
.pz-ls{padding:0 8px 8px;flex:none}
.pz-lsb{height:8px;border-radius:4px;background:#ff4d6d;overflow:hidden}.pz-lsb div{height:100%;background:#2ee6a0;transition:width 1s}
.pz-lsl{display:flex;justify-content:space-between;font-size:10px;margin-top:4px;color:var(--mut)}
.pz-bot{display:grid;grid-template-columns:1fr 1.45fr 1fr 1fr;gap:6px;min-height:0}
.pz-gl{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:2px 10px}
.pz-gl a{font-size:11px;display:flex;justify-content:space-between;padding:3.5px 0;border-bottom:1px dashed #1a1a26}
.pz-tapebody{position:absolute;left:0;right:0;top:28px;bottom:6px;display:grid;grid-template-columns:1fr 124px;gap:4px;padding:0 8px}
.pz-tape{width:100%;height:100%}
.pz-book{font-size:9.5px;display:flex;flex-direction:column;justify-content:center;gap:1px}
.pz-bk{display:flex;justify-content:space-between;padding:1px 5px;position:relative}
.pz-bk i{position:absolute;right:0;top:0;bottom:0;opacity:.18}
.pz-bkmid{text-align:center;font-weight:700;font-size:11px;padding:3px}
.pz-pm{padding:2px 10px;display:flex;flex-direction:column;gap:7px}
.pz-pq{font-size:11.5px;display:block}
.pz-bar{display:flex;height:20px;border-radius:5px;overflow:hidden;margin-top:4px;font-size:10px;font-weight:700}
.pz-bar div{display:flex;align-items:center;padding:0 7px;white-space:nowrap}
.pz-yes{background:linear-gradient(90deg,#1c7a56,#2ee6a0);color:#032}.pz-no{flex:1;background:linear-gradient(90deg,#5a1c2a,#8a2a3e);justify-content:flex-end}
.pz-hm{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;padding:2px 10px}
.pz-hm a{font-size:9.5px;padding:6px 2px;border-radius:4px;text-align:center;font-weight:600;overflow:hidden;white-space:nowrap}
.pz-hm a small{display:block;font-size:8.5px;opacity:.8}
.pz-liq{display:flex;gap:6px;padding:6px 10px}.pz-liq div{flex:1;background:#0b0b12;border:1px solid #171724;border-radius:6px;padding:5px 7px}
.pz-liq small{font-size:8.5px;letter-spacing:.12em;color:var(--mut);font-weight:700;display:block}.pz-liq b{font-size:13px}
.pz-note{font-size:10px;color:var(--mut);text-align:center;margin:0}
.pz-tv .pz-note{display:none}
.pz-tv{grid-template-rows:52px 28px 66px minmax(0,1fr) 236px}

@media (max-width:1180px){
 .pz-agents{grid-template-columns:repeat(4,1fr);grid-auto-rows:60px}.pz-agents>:nth-child(n+5){display:none}
 .pz-main{grid-template-columns:240px minmax(0,1fr) 280px}
 .pz-st:nth-child(3){display:none}
 .pz-hud{top:auto;bottom:10px}
}
@media (max-width:820px){
 .pz-desk{display:flex;flex-direction:column;height:auto;min-height:0;padding:8px;gap:8px}
 .pz-tv{position:static;height:auto}
 .pz-top{height:48px;gap:10px;padding:0 10px}.pz-st{display:none}.pz-clock{font-size:15px}.pz-stats{gap:8px}.pz-fs{display:none}
 .pz-tick{height:28px;flex:none}
 .pz-agents{display:flex;overflow-x:auto;gap:6px;height:58px;scrollbar-width:none;flex:none}.pz-agents::-webkit-scrollbar{display:none}
 .pz-agents>:nth-child(n+5){display:flex}.pz-ag{min-width:150px}
 .pz-main{display:flex;flex-direction:column}
 .pz-reactor{order:-1;height:360px;flex:none}
 .pz-feed{display:grid;grid-template-columns:1fr 1fr;height:auto}.pz-fc{grid-template-columns:1fr auto}.pz-fc .pz-spark{display:none}
 .pz-big b,.pz-big2 b{font-size:19px}
 .pz-hud div:nth-child(3){display:none}.pz-hud div{padding:4px 8px}
 .pz-chip{display:none}
 .pz-hud{top:auto;bottom:10px}
 .pz-bot{display:flex;flex-direction:column}.pz-bot>.pz-panel{min-height:200px}.pz-tapep{height:220px}
}

/* Explore strip */
.pz-strip{position:relative;height:360px;border-radius:18px;overflow:hidden;background:var(--bg);border:1px solid #1d1d2a}
.pz-strip .pz-big,.pz-strip .pz-big2{top:14px}
.pz-badge{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#ff6b1a;color:#140600;font-weight:800;font-size:10px;letter-spacing:.12em;padding:5px 10px;border-radius:999px;z-index:2;white-space:nowrap}
.pz-wire{position:absolute;left:14px;bottom:16px;z-index:2;font-size:11.5px;background:#0a0a12e6;border:1px solid var(--c);border-radius:999px;padding:8px 12px;max-width:calc(100% - 220px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pz-wire b{color:#ffa04d}
.pz-cta{position:absolute;right:14px;bottom:14px;z-index:2;background:#ff6b1a;color:#140600 !important;font-weight:800;font-size:13px;padding:10px 16px;border-radius:999px;box-shadow:0 0 24px -4px #ff6b1a;white-space:nowrap}
@media (max-width:640px){
 .pz-strip{height:340px;border-radius:16px}
 .pz-strip .pz-chip{display:none}
 .pz-strip .pz-big b,.pz-strip .pz-big2 b{font-size:18px}
 .pz-badge{top:16px;font-size:8.5px;padding:4px 8px}
 .pz-wire{left:12px;right:12px;bottom:62px;max-width:none;text-align:center}
 .pz-cta{left:12px;right:12px;bottom:12px;text-align:center}
}
`;
