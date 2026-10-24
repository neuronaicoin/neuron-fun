"use client";

/**
 * The live chart on every coin page: a smooth line of the coin's market cap (or price) that
 * moves on its own as time passes, with:
 *
 *   - touch / mouse scrubbing: a crosshair, the value and time at that point
 *   - smooth changes between time ranges (no jump: the scale and the line glide)
 *   - a breathing dot at the tip that bursts on every trade: stars flying out on buys (more
 *     buys at once, a bigger burst), red pieces falling on sells
 *   - on sasa's own coins (`trades`): who traded on the line itself (the creator, you, people
 *     you follow, whales), close ones grouped with a count, sells as red dots
 *
 * Coins without a trade feed (other DEXs) still burst: when the price moves between two
 * refreshes, green up or red down.
 *
 * Canvas, no chart library; the Pro view (candles, indicators) is components/perpschart.tsx.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RaceCandle } from "@/lib/race";

export type LiveTrade = {
  /** unique per trade (to burst once) */
  id: string;
  /** ms */
  t: number;
  buy: boolean;
  usd: number;
  /** who, when worth showing on the line */
  who: "dev" | "you" | "follow" | "whale" | null;
  /** short label for `follow` (initials) */
  label?: string;
};

export type LiveRange = { label: string; /** candle size, s */ frame: number; /** shown span, s (null: everything) */ span: number | null };

type Pt = { t: number; v: number };

const prefersReduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** CSS color tokens of the current theme (they change with the theme button). */
function themeColors() {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return {
    up: g("--color-up", "#12a150"),
    down: g("--color-danger", "#e5484d"),
    ink: g("--color-ink", "#16120f"),
    ink3: g("--color-ink-3", "#857e77"),
    line: g("--color-line", "#eeebe7"),
    accent: g("--color-emerald", "#f2600c"),
    gold: g("--color-mint", "#c27a00"),
    surface: g("--color-surface", "#ffffff"),
    font: s.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
    display: s.getPropertyValue("--font-display").trim() || "system-ui, sans-serif",
  };
}

/** "#12a150" / "rgb(…)" → "rgba(r,g,b,a)" */
function alpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1, 7);
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(",").map((x) => x.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

const WHO_RING: Record<NonNullable<LiveTrade["who"]>, "accent" | "whale" | "up" | "gold"> = { dev: "accent", whale: "whale", you: "up", follow: "gold" };
const WHO_LABEL: Record<NonNullable<LiveTrade["who"]>, string> = { dev: "DEV", whale: "W", you: "YOU", follow: "" };

export function LiveChart({
  cacheKey,
  load,
  ranges,
  defaultRange,
  format,
  height = 320,
  refreshMs = 5_000,
  refreshOn,
  trades,
  emptyText = "No trades yet. The first one draws the chart.",
  onFail,
  toolbarStart,
  toolbarEnd,
  bleed = false,
}: {
  cacheKey: string;
  /** candles of one candle size (s), oldest first, values already in what is shown (MC or price) */
  load: (frameSec: number) => Promise<RaceCandle[]>;
  ranges: LiveRange[];
  defaultRange: string;
  format: (v: number) => string;
  height?: number;
  refreshMs?: number;
  /** extra refreshes (e.g. right after the user trades); returns the unsubscribe */
  refreshOn?: (refresh: () => void) => () => void;
  /** sasa's own coins: the latest trades (newest first or any order) */
  trades?: LiveTrade[];
  emptyText?: string;
  onFail?: () => void;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  bleed?: boolean;
}) {
  const [range, setRange] = useState(() => (ranges.some((r) => r.label === defaultRange) ? defaultRange : ranges[0].label));
  const r = ranges.find((x) => x.label === range) ?? ranges[0];
  const [rows, setRows] = useState<Pt[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [scrub, setScrub] = useState<{ v: number; t: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const fmtRef = useRef(format);
  fmtRef.current = format;

  // everything the drawing loop reads, without re-running effects
  const st = useRef({
    pts: [] as Pt[],
    prevPts: [] as Pt[],
    fade: 1,
    span: 0,
    spanTarget: 0,
    lo: NaN,
    hi: NaN,
    tipV: NaN,
    pulse: 0,
    pulseUp: true,
    parts: [] as { x: number; y: number; vx: number; vy: number; life: number; size: number; star: boolean; up: boolean; gold: boolean }[],
    scrubX: null as number | null,
    scrubFade: 0,
    trades: [] as LiveTrade[],
    seen: new Set<string>(),
    seeded: false,
    lastClose: NaN,
    lastLen: 0,
  });

  // ---------------------------------------------------------------- data
  useEffect(() => {
    let alive = true;
    const s = st.current;
    const k = `${cacheKey}:${r.frame}`;
    const cached = CACHE.get(k);
    if (cached) setRows(cached);
    const get = async (first: boolean) => {
      try {
        const c = await loadRef.current(r.frame);
        if (!alive) return;
        const pts = c.filter((x) => Number.isFinite(x.close) && x.close > 0).map((x) => ({ t: x.t * 1000, v: x.close }));
        CACHE.set(k, pts);
        setRows(pts);
        setFailed(false);
        // other DEXs' coins (no trade feed): a burst when the price moved since the last refresh
        if (!s.trades.length && pts.length) {
          const last = pts[pts.length - 1].v;
          if (!first && Number.isFinite(s.lastClose) && s.lastLen > 0 && last !== s.lastClose) {
            const ch = (last - s.lastClose) / s.lastClose;
            const n = Math.min(4, 1 + Math.floor(Math.abs(ch) * 100));
            burst(s, ch > 0, n);
          }
          s.lastClose = last;
          s.lastLen = pts.length;
        }
      } catch {
        if (!alive) return;
        if (first && !cached) {
          setFailed(true);
          failRef.current?.();
        }
      }
    };
    void get(true);
    const t = setInterval(() => document.visibilityState === "visible" && void get(false), refreshMs);
    const stop = refreshOn?.(() => {
      [1200, 3000, 6000].forEach((d) => setTimeout(() => alive && void get(false), d));
    });
    return () => {
      alive = false;
      clearInterval(t);
      stop?.();
    };
  }, [cacheKey, r.frame, refreshMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new set of points: cross-fade from the old line, the span glides to the new range
  useEffect(() => {
    if (!rows) return;
    const s = st.current;
    const changed = s.pts.length && (s.pts[0]?.t !== rows[0]?.t || Math.abs(s.pts.length - rows.length) > 3);
    if (changed && !prefersReduced()) {
      s.prevPts = s.pts;
      s.fade = 0;
    }
    s.pts = rows;
    const span = r.span ? r.span * 1000 : rows.length ? Math.max(60_000, Date.now() - rows[0].t) : 3_600_000;
    s.spanTarget = span;
    if (!s.span) s.span = span;
  }, [rows, r.span]);

  // trades of sasa's own coins: burst once per new trade (several at once: a bigger burst)
  useEffect(() => {
    const s = st.current;
    const list = trades ?? [];
    s.trades = list;
    const fresh = list.filter((x) => !s.seen.has(x.id));
    list.forEach((x) => s.seen.add(x.id));
    if (!s.seeded) {
      s.seeded = list.length > 0 || trades !== undefined;
      return;
    }
    if (!fresh.length) return;
    const buys = fresh.filter((x) => x.buy).length;
    const sells = fresh.length - buys;
    if (buys) burst(s, true, Math.min(6, buys + (fresh.some((x) => x.buy && x.who === "whale") ? 2 : 0)));
    if (sells && !buys) burst(s, false, Math.min(4, sells));
  }, [trades]);

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const s = st.current;
    const reduce = prefersReduced();
    let W = 0;
    let H = 0;
    let raf = 0;
    let C = themeColors();
    const resize = () => {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      W = cv.clientWidth;
      H = cv.clientHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();
    // the theme button changes the colors
    const mo = new MutationObserver(() => (C = themeColors()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    let lastFrame = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(64, now - lastFrame) / 16.7;
      lastFrame = now;
      ctx.clearRect(0, 0, W, H);
      const pts = s.pts;
      const PAD = { l: 6, r: Math.min(92, Math.max(70, W * 0.2)), t: 38, b: 24 };
      const x0 = PAD.l;
      const x1 = W - PAD.r;
      const y0 = PAD.t;
      const y1 = H - PAD.b;
      if (!pts.length || W < 50) {
        raf = requestAnimationFrame(frame);
        return;
      }
      // time window: ends now (the line keeps moving), span glides between ranges
      s.span += (s.spanTarget - s.span) * (reduce ? 1 : Math.min(1, 0.12 * dt));
      const tEnd = Date.now();
      const tStart = tEnd - s.span;
      const X = (t: number) => x0 + ((t - tStart) / (tEnd - tStart)) * (x1 - x0);
      // what's in view (plus the point just before, so the line enters from the left edge)
      let from = pts.findIndex((p) => p.t >= tStart);
      if (from === -1) from = pts.length - 1;
      const view = pts.slice(Math.max(0, from - 1));
      // the tip glides to the latest value
      const last = pts[pts.length - 1].v;
      if (!Number.isFinite(s.tipV) || reduce) s.tipV = last;
      else s.tipV += (last - s.tipV) * Math.min(1, 0.18 * dt);
      // scale glides too
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of view) {
        mn = Math.min(mn, p.v);
        mx = Math.max(mx, p.v);
      }
      mn = Math.min(mn, s.tipV);
      mx = Math.max(mx, s.tipV);
      const pad = (mx - mn) * 0.14 || mx * 0.06 || 1;
      const tLo = mn - pad;
      const tHi = mx + pad;
      if (!Number.isFinite(s.lo) || reduce) {
        s.lo = tLo;
        s.hi = tHi;
      } else {
        s.lo += (tLo - s.lo) * Math.min(1, 0.12 * dt);
        s.hi += (tHi - s.hi) * Math.min(1, 0.12 * dt);
      }
      const Y = (v: number) => y1 - ((v - s.lo) / (s.hi - s.lo || 1)) * (y1 - y0);

      // grid and the value scale
      ctx.font = `500 10px ${C.font}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      let lastLabel = "";
      for (let g = 0; g <= 3; g++) {
        const v = s.lo + ((s.hi - s.lo) * (g + 0.5)) / 4;
        const y = Y(v);
        const text = fmtRef.current(v);
        ctx.strokeStyle = alpha(C.ink3, 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        if (text !== lastLabel) {
          ctx.fillStyle = C.ink3;
          ctx.fillText(text, x1 + 18, y);
        }
        lastLabel = text;
      }
      // times along the bottom
      ctx.textAlign = "center";
      for (let k = 1; k <= 3; k++) {
        const t = tStart + ((tEnd - tStart) * k) / 4;
        ctx.fillStyle = C.ink3;
        ctx.fillText(timeLabel(t, s.span), x0 + ((x1 - x0) * k) / 4, H - 10);
      }

      const up = s.tipV >= (view[0]?.v ?? s.tipV);
      const lc = up ? C.up : C.down;
      const drawLine = (list: Pt[], tip: number | null, a: number) => {
        if (!list.length) return;
        const path = new Path2D();
        let px = X(list[0].t);
        let py = Y(list[0].v);
        path.moveTo(px, py);
        for (let i = 1; i < list.length; i++) {
          const nx = X(list[i].t);
          const ny = Y(list[i].v);
          const xm = (px + nx) / 2;
          path.bezierCurveTo(xm, py, xm, ny, nx, ny);
          px = nx;
          py = ny;
        }
        if (tip !== null) {
          // last point → now, gliding to the newest value
          const tx = X(tEnd);
          const ty = Y(tip);
          const xm = (px + tx) / 2;
          path.bezierCurveTo(xm, py, xm, ty, tx, ty);
          px = tx;
        }
        const area = new Path2D(path);
        area.lineTo(px, y1);
        area.lineTo(X(list[0].t), y1);
        area.closePath();
        ctx.save();
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0 + 1, H);
        ctx.clip();
        const gr = ctx.createLinearGradient(0, y0, 0, y1);
        gr.addColorStop(0, alpha(lc, 0.22));
        gr.addColorStop(1, alpha(lc, 0));
        ctx.fillStyle = gr;
        ctx.fill(area);
        ctx.shadowColor = alpha(lc, 0.55);
        ctx.shadowBlur = 10;
        ctx.strokeStyle = lc;
        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(path);
        ctx.restore();
      };
      // the old line fades out while the new one fades in
      if (s.fade < 1) {
        s.fade = Math.min(1, s.fade + 0.06 * dt);
        drawLine(s.prevPts.filter((p) => p.t >= tStart - s.span * 0.05), null, 1 - ease(s.fade));
      }
      // the line is drawn to the last real point, then to "now" at the gliding tip value
      const body = view.slice(0, -1).concat([{ t: view[view.length - 1].t, v: view.length === 1 ? s.tipV : view[view.length - 1].v }]);
      drawLine(body, s.tipV, s.fade < 1 ? ease(s.fade) : 1);

      const tipX = X(tEnd);
      const tipY = Y(s.tipV);

      // dashed line and the current value
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = alpha(C.ink3, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, tipY);
      ctx.lineTo(x1, tipY);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = fmtRef.current(s.tipV);
      ctx.font = `700 11px ${C.font}`;
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = lc;
      pill(ctx, x1 + 12, tipY - 11, Math.min(tw, PAD.r - 14), 22, 11);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(label, x1 + 19, tipY + 0.5);

      // who traded, on the line (sasa's own coins)
      if (s.trades.length) {
        const value = (t: number) => {
          // the line's value at time t
          let i = pts.findIndex((p) => p.t >= t);
          if (i === -1) return s.tipV;
          if (i === 0) return pts[0].v;
          const a = pts[i - 1];
          const b = pts[i];
          return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
        };
        type G = { x: number; y: number; buy: boolean; n: number; who: LiveTrade["who"]; label: string };
        const groups: G[] = [];
        const rank = { dev: 4, you: 3, follow: 2, whale: 1 } as const;
        for (const tr of s.trades.slice(0, 60)) {
          if (tr.t < tStart || tr.t > tEnd) continue;
          if (tr.buy && !tr.who) continue;
          if (!tr.buy && tr.usd < 5 && !tr.who) continue;
          const x = Math.max(x0 + 11, Math.min(x1 - 11, X(tr.t)));
          const y = Y(value(tr.t));
          const g = groups.find((q) => Math.abs(q.x - x) < 18 && q.buy === tr.buy);
          const lab = tr.who === "follow" ? (tr.label || "★").slice(0, 2).toUpperCase() : tr.who ? WHO_LABEL[tr.who] : "";
          if (g) {
            g.n++;
            if (tr.who && (!g.who || rank[tr.who] > rank[g.who])) {
              g.who = tr.who;
              g.label = lab;
            }
          } else groups.push({ x, y, buy: tr.buy, n: 1, who: tr.who, label: lab });
        }
        for (const g of groups) {
          if (!g.buy && !g.who) {
            ctx.fillStyle = C.down;
            ctx.strokeStyle = C.surface;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(g.x, g.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            continue;
          }
          const ring = g.who ? WHO_RING[g.who] : "gold";
          const rc = !g.buy ? C.down : ring === "accent" ? C.accent : ring === "whale" ? "#3b82f6" : ring === "up" ? C.up : C.gold;
          const rr = 10;
          const by = g.buy ? g.y - 15 : g.y + 15;
          ctx.fillStyle = C.surface;
          ctx.strokeStyle = rc;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(g.x, by, rr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = C.ink;
          ctx.font = `800 ${g.label.length > 2 ? 7 : 8}px ${C.display}`;
          ctx.textAlign = "center";
          ctx.fillText(g.label, g.x, by + 0.5);
          if (g.n > 1) {
            ctx.fillStyle = rc;
            ctx.beginPath();
            ctx.arc(g.x + rr, by - rr + 1, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = `800 8px ${C.display}`;
            ctx.fillText(g.n > 9 ? "9+" : String(g.n), g.x + rr, by - rr + 1.5);
          }
        }
      }

      // burst pieces from the tip
      for (let k = s.parts.length - 1; k >= 0; k--) {
        const p = s.parts[k];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.03 * dt;
        p.vx *= 0.985;
        p.life -= 0.021 * dt;
        if (p.life <= 0) {
          s.parts.splice(k, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.up ? (p.gold ? C.gold : C.up) : C.down;
        const px = tipX + p.x * 6;
        const py = tipY + p.y * 6;
        if (p.star) sparkle(ctx, px, py, p.size * 2.2 * p.life + 1);
        else {
          ctx.beginPath();
          ctx.arc(px, py, p.size * p.life + 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // the tip: breathes, swells on each trade
      s.pulse = Math.max(0, s.pulse - 0.025 * dt);
      const breathe = reduce ? 0 : (Math.sin(now / 380) + 1) / 2;
      const tc = s.pulse > 0.05 ? (s.pulseUp ? C.up : C.down) : lc;
      const r0 = 4.5 + s.pulse * 8;
      ctx.fillStyle = alpha(tc, 0.18);
      ctx.beginPath();
      ctx.arc(tipX, tipY, r0 + 5 + breathe * 5 + s.pulse * 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tc;
      ctx.beginPath();
      ctx.arc(tipX, tipY, r0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(tipX, tipY, 1.8, 0, Math.PI * 2);
      ctx.fill();

      // scrubbing: crosshair on the nearest point
      s.scrubFade += ((s.scrubX !== null ? 1 : 0) - s.scrubFade) * Math.min(1, 0.25 * dt);
      if (s.scrubX !== null || s.scrubFade > 0.02) {
        const sx = Math.max(x0, Math.min(x1, s.scrubX ?? tipX));
        const t = tStart + ((sx - x0) / (x1 - x0)) * (tEnd - tStart);
        // the line's value right under the finger (flat after the last trade)
        const i = pts.findIndex((p) => p.t >= t);
        const v =
          i === -1 ? s.tipV : i === 0 ? pts[0].v : pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * (t - pts[i - 1].t)) / (pts[i].t - pts[i - 1].t || 1);
        const px = sx;
        const py = Y(v);
        const best = { t };
        ctx.globalAlpha = s.scrubFade;
        ctx.strokeStyle = alpha(C.ink3, 0.6);
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(px, y0 - 8);
        ctx.lineTo(px, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.surface;
        ctx.strokeStyle = lc;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (s.scrubX !== null) scrubOut.current?.(v, Math.round(best.t / 1000) * 1000);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // the scrub readout is React state, updated only when it changes
  const scrubOut = useRef<((v: number, t: number) => void) | null>(null);
  scrubOut.current = (v, t) => setScrub((cur) => (cur && cur.v === v && cur.t === t ? cur : { v, t }));

  const pos = (e: React.PointerEvent) => e.clientX - (canvas.current?.getBoundingClientRect().left ?? 0);
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    st.current.scrubX = pos(e);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" || e.currentTarget.hasPointerCapture(e.pointerId)) st.current.scrubX = pos(e);
  };
  const onEnd = () => {
    st.current.scrubX = null;
    setScrub(null);
  };

  const empty = rows !== null && rows.length === 0;
  const change = useMemo(() => {
    if (!rows || rows.length < 2) return null;
    const span = r.span ? r.span * 1000 : null;
    const start = span ? (rows.find((p) => p.t >= Date.now() - span) ?? rows[rows.length - 1]) : rows[0];
    const last = rows[rows.length - 1];
    return start.v > 0 ? ((last.v - start.v) / start.v) * 100 : null;
  }, [rows, r.span]);

  return (
    <div className={"flex flex-col gap-2.5 min-w-0 " + (bleed ? "-mx-4 sm:mx-0" : "")}>
      <div className={"relative rounded-2xl overflow-hidden " + (bleed ? "rounded-none sm:rounded-2xl" : "")} style={{ height }}>
        <canvas
          ref={canvas}
          className="absolute inset-0 w-full h-full touch-none select-none cursor-crosshair"
          data-no-ptr
          aria-label="Price chart. Drag across it to see past values."
          role="img"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onEnd}
          onPointerCancel={onEnd}
          onPointerLeave={(e) => e.pointerType === "mouse" && onEnd()}
        />
        {/* the value under the finger, or the range's change */}
        <div className="absolute top-2 left-3 sm:left-4 pointer-events-none font-mono tabular-nums text-[0.9375rem] font-bold leading-tight min-h-[1.25rem]">
          {scrub ? (
            <>
              {format(scrub.v)}
              <span className="ml-2 text-[0.75rem] font-medium text-ink-3">{fullTime(scrub.t)}</span>
            </>
          ) : change !== null ? (
            <span className={change >= 0 ? "text-up" : "text-danger"}>
              {change >= 0 ? "↑" : "↓"} {Math.abs(change) >= 1000 ? Math.round(Math.abs(change)).toLocaleString("en-US") : Math.abs(change).toFixed(1)}%
              <span className="ml-1.5 text-[0.75rem] font-medium text-ink-3">{r.span ? range : "all time"}</span>
            </span>
          ) : null}
        </div>
        {rows === null && !failed && <div className="absolute inset-0 shimmer opacity-40" aria-hidden="true" />}
        {(empty || (failed && !rows)) && (
          <p className="absolute inset-0 grid place-items-center text-[0.875rem] text-ink-3 px-6 text-center">{failed ? "The chart couldn't load. It tries again by itself." : emptyText}</p>
        )}
      </div>
      <div className={"flex items-center gap-2 flex-wrap " + (bleed ? "px-4 sm:px-0" : "")}>
        {toolbarStart}
        <div className="flex bg-night rounded-full p-1" role="group" aria-label="Time range">
          {ranges.map((x) => (
            <button
              key={x.label}
              type="button"
              onClick={() => setRange(x.label)}
              aria-pressed={x.label === range}
              className={"h-8 px-3 rounded-full text-[0.8125rem] font-medium " + (x.label === range ? "bg-paper text-ink shadow-sm" : "text-ink-2")}
            >
              {x.label}
            </button>
          ))}
        </div>
        {toolbarEnd && <div className="ml-auto">{toolbarEnd}</div>}
      </div>
    </div>
  );
}

const CACHE = new Map<string, Pt[]>();

/** Sends pieces out of the tip: up and everywhere on buys (n: how many at once), down on sells. */
function burst(s: { parts: { x: number; y: number; vx: number; vy: number; life: number; size: number; star: boolean; up: boolean; gold: boolean }[]; pulse: number; pulseUp: boolean }, up: boolean, n: number) {
  s.pulse = Math.min(1.4, 0.7 + n * 0.15);
  s.pulseUp = up;
  if (prefersReduced() || typeof document === "undefined" || document.visibilityState !== "visible") return;
  const count = up ? 10 + n * 8 : 10 + n * 4;
  for (let j = 0; j < count && s.parts.length < 160; j++) {
    const a = up ? Math.random() * Math.PI * 2 : Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const sp = (up ? 1.1 + n * 0.45 : 1.2 + n * 0.2) * (0.6 + Math.random());
    s.parts.push({
      x: 0,
      y: 0,
      vx: Math.cos(a) * sp * 0.6,
      vy: Math.sin(a) * sp * 0.6 - (up ? 0.3 : -0.15),
      life: 1,
      size: (up ? 2.6 + n * 0.5 : 2.2) * (0.6 + Math.random() * 0.8),
      star: up && Math.random() < 0.6,
      up,
      gold: Math.random() < 0.3,
    });
  }
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  for (let a = 0; a < 8; a++) {
    const rr = a % 2 === 0 ? size : size * 0.32;
    const ang = (a * Math.PI) / 4;
    ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function timeLabel(t: number, span: number): string {
  const d = new Date(t);
  if (span > 2 * 86_400_000) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fullTime(t: number): string {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return today ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}
