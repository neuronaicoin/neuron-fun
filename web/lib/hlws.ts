/**
 * Hyperliquid's live feed (wss://api.hyperliquid.xyz/ws): one shared connection for the whole
 * page. Each `hlSubscribe` asks for one stream and gets its messages; the same stream asked for
 * twice is sent once. The connection pings to stay open, comes back by itself after a drop (and
 * asks for every stream again), and closes when nothing is listening any more.
 */
export const HL_WS = "wss://api.hyperliquid.xyz/ws";

type Sub = Record<string, unknown> & { type: string };
type Listener = (data: unknown) => void;
/** Called when the feed (re)connects or drops, so a page can fill the gap with a normal fetch. */
type StatusFn = (up: boolean) => void;

const subs = new Map<string, { sub: Sub; listeners: Set<Listener> }>();
const statusFns = new Set<StatusFn>();
let ws: WebSocket | null = null;
let up = false;
let ping: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let tries = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** The key Hyperliquid's replies can be matched by (channel + the stream's own fields). */
export function subKey(s: Sub): string {
  const coin = typeof s.coin === "string" ? s.coin : "";
  const interval = typeof s.interval === "string" ? s.interval : "";
  const user = typeof s.user === "string" ? s.user.toLowerCase() : "";
  return `${s.type}|${coin}|${interval}|${user}`;
}

/** Which stream a message belongs to. */
export function keyOfMessage(m: { channel?: string; data?: unknown }): string | null {
  const d = m.data as Record<string, unknown> | undefined;
  if (!m.channel || !d) return null;
  if (m.channel === "candle") return `candle|${String(d.s ?? "")}|${String(d.i ?? "")}|`;
  if (m.channel === "activeAssetCtx") return `activeAssetCtx|${String(d.coin ?? "")}||`;
  if (m.channel === "trades" && Array.isArray(m.data) && m.data.length) return `trades|${String((m.data[0] as { coin?: string }).coin ?? "")}||`;
  if (m.channel === "l2Book") return `l2Book|${String(d.coin ?? "")}||`;
  return null;
}

function setUp(v: boolean) {
  if (up === v) return;
  up = v;
  statusFns.forEach((f) => {
    try {
      f(v);
    } catch {}
  });
}

function send(o: unknown) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function open() {
  if (ws || typeof WebSocket === "undefined") return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(HL_WS);
  } catch {
    schedule();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    tries = 0;
    subs.forEach(({ sub }) => send({ method: "subscribe", subscription: sub }));
    if (ping) clearInterval(ping);
    // Hyperliquid closes a connection that is quiet for a minute
    ping = setInterval(() => send({ method: "ping" }), 30_000);
    setUp(true);
  };
  sock.onmessage = (ev) => {
    let m: { channel?: string; data?: unknown };
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const k = keyOfMessage(m);
    const entry = k ? subs.get(k) : undefined;
    if (!entry) return;
    entry.listeners.forEach((f) => {
      try {
        f(m.data);
      } catch {}
    });
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (ping) clearInterval(ping);
    ping = null;
    setUp(false);
    if (subs.size) schedule();
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {}
  };
}

function schedule() {
  if (retry) return;
  // 1 s, 2 s, 4 s … up to 30 s between tries
  const wait = Math.min(30_000, 1000 * 2 ** Math.min(tries, 5));
  tries++;
  retry = setTimeout(() => {
    retry = null;
    if (subs.size) open();
  }, wait);
}

/** Listen to one stream; returns the function that stops listening. */
export function hlSubscribe(sub: Sub, fn: Listener): () => void {
  const k = subKey(sub);
  let entry = subs.get(k);
  if (!entry) {
    entry = { sub, listeners: new Set() };
    subs.set(k, entry);
    send({ method: "subscribe", subscription: sub });
  }
  entry.listeners.add(fn);
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  open();
  return () => {
    const e = subs.get(k);
    if (!e) return;
    e.listeners.delete(fn);
    if (e.listeners.size) return;
    subs.delete(k);
    send({ method: "unsubscribe", subscription: e.sub });
    if (!subs.size && !closeTimer) {
      // a page switching markets subscribes again right away: keep the line open a moment
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (subs.size || !ws) return;
        const s = ws;
        ws = null;
        if (ping) clearInterval(ping);
        ping = null;
        setUp(false);
        try {
          s.close();
        } catch {}
      }, 5_000);
    }
  };
}

/** Hear when the feed comes up or drops (called at once with the current state). */
export function hlOnStatus(fn: StatusFn): () => void {
  statusFns.add(fn);
  fn(up);
  return () => {
    statusFns.delete(fn);
  };
}

/** A candle as Hyperliquid streams it (prices as strings, time in ms). */
export type HlWsCandle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };
