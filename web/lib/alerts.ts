/**
 * Price alerts, the 🔔 list and phone notifications, on the client.
 *
 * One small shared store (no React context needed): the header bell, the
 * coin page bell and the chart all read from it. The server side lives in
 * functions/api/[[path]].js (Cloudflare) and indexer/alerts.mjs (Railway).
 */
import { useSyncExternalStore } from "react";
import { VAPID_PUBLIC_KEY } from "./config";

// ------------------------------------------------------------------ types

export type AlertKind = "mc" | "price" | "move" | "bond" | "grad";
export type AlertDir = "above" | "below" | "up" | "down" | "any" | "";

export type Alert = {
  id: number;
  coinId: string;
  kind: AlertKind;
  dir: AlertDir;
  target: number;
  repeat: boolean;
  push: boolean;
  active: boolean;
  firedAt: string | null;
  createdAt: string;
  coin: { name: string; symbol: string; logo: string } | null;
};

export type Note = {
  id: number;
  coinId: string | null;
  kind: string;
  title: string;
  body: string;
  url: string;
  read: boolean;
  createdAt: string;
};

/**
 * unsupported: this browser can't do web push · ios-install: iPhone, needs the
 * home-screen app first · denied: blocked in browser settings · off / on.
 */
export type PushState = "unknown" | "unsupported" | "ios-install" | "denied" | "off" | "on";

type State = {
  address: string | null;
  signedIn: boolean;
  alerts: Alert[] | null;
  notes: Note[] | null;
  unread: number;
  push: PushState;
  /** Bumped when a new unread notification arrives (rings the bell). */
  ring: number;
};

export const MAX_ALERTS = 50;

// ------------------------------------------------------------------ store

let state: State = { address: null, signedIn: false, alerts: null, notes: null, unread: 0, push: "unknown", ring: 0 };
const listeners = new Set<() => void>();
const SERVER_STATE = state;

function set(p: Partial<State>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useAlerts(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => SERVER_STATE
  );
}

// ------------------------------------------------------------------ session

type Session = { token: string; exp: number };
const sessionKey = (a: string) => `sasa-session:${a.toLowerCase()}`;
let session: Session | null = null;

function loadSession(a: string): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(sessionKey(a)) ?? "null") as Session | null;
    if (s && typeof s.token === "string" && s.exp * 1000 > Date.now() + 60_000) return s;
  } catch {}
  return null;
}
function saveSession(a: string, s: Session | null) {
  try {
    if (s) {
      localStorage.setItem(sessionKey(a), JSON.stringify(s));
      // The forum pages (plain HTML) read this to know who is signed in.
      localStorage.setItem("sasa-session-current", a.toLowerCase());
    } else localStorage.removeItem(sessionKey(a));
  } catch {}
}

export class SignInNeeded extends Error {}

export type SignFn = (message: string) => Promise<string>;

/** Signs in once per wallet (a free message signature, no transaction). */
export async function ensureSession(sign: SignFn): Promise<void> {
  const address = state.address;
  if (!address) throw new Error("Log in first.");
  if (session) return;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = [
    "Sign in to sasa to use price alerts.",
    "",
    "This is free and doesn't send a transaction.",
    "",
    `Site: ${location.host}`,
    `Address: ${address}`,
    `Issued: ${new Date().toISOString()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
  const signature = await sign(message);
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, message, signature }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: string; expires?: number; error?: string };
  if (!r.ok || !j.token || !j.expires) throw new Error(j.error ?? "Couldn't sign in. Try again.");
  if (state.address !== address) return; // wallet changed meanwhile
  session = { token: j.token, exp: j.expires };
  saveSession(address, session);
  set({ signedIn: true });
  void refreshAll();
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!session || !state.address) throw new SignInNeeded("Sign in first.");
  const r = await fetch(`/api/${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${session.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (r.status === 401) {
    saveSession(state.address, null);
    session = null;
    set({ signedIn: false });
    throw new SignInNeeded(j.error ?? "Please sign in again.");
  }
  if (!r.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j;
}

// ------------------------------------------------------------------ wallet changes, polling

let pollTimer: ReturnType<typeof setInterval> | null = null;
let wired = false;

/** Called by <AlertsSync/> whenever the logged-in wallet changes. */
export function setAlertsAddress(address: string | null) {
  const a = address ? address.toLowerCase() : null;
  if (a === state.address) return;
  session = a ? loadSession(a) : null;
  if (a && session) {
    try {
      localStorage.setItem("sasa-session-current", a);
    } catch {}
  }
  set({ address: a, signedIn: !!session, alerts: null, notes: null, unread: 0 });
  wireOnce();
  void checkPush();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (a) {
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshNotes();
    }, 60_000);
    if (session) void refreshAll();
  }
}

function wireOnce() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshNotes();
  });
  // A push arrived while the site is open: show it in the 🔔 at once.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if ((e.data as { type?: string } | null)?.type === "sasa-note") void refreshNotes();
    });
  }
}

export async function refreshAll() {
  await Promise.all([refreshAlerts(), refreshNotes()]);
  void syncPushSubscription();
}

export async function refreshAlerts() {
  if (!session) return;
  try {
    const j = await api<{ alerts: Alert[] }>("alerts");
    set({ alerts: j.alerts });
  } catch {}
}

export async function refreshNotes() {
  if (!session) return;
  try {
    const before = state.notes;
    const j = await api<{ notes: Note[]; unread: number }>("notes");
    const newest = before && before.length ? before[0].id : 0;
    const fresh = before !== null && j.notes.some((n) => n.id > newest && !n.read);
    set({ notes: j.notes, unread: j.unread, ring: fresh ? state.ring + 1 : state.ring });
    // A notification means an alert may have switched itself off.
    if (fresh) void refreshAlerts();
  } catch {}
}

// ------------------------------------------------------------------ alerts

export type NewAlert = { coinId: string; kind: AlertKind; dir: AlertDir; target: number; repeat: boolean; push: boolean };

export async function createAlert(a: NewAlert): Promise<Alert> {
  const j = await api<{ alert: Alert }>("alerts", { method: "POST", body: a });
  set({ alerts: [j.alert, ...(state.alerts ?? [])] });
  return j.alert;
}

export async function updateAlert(id: number, patch: { active?: boolean; repeat?: boolean; push?: boolean }) {
  const j = await api<{ alert: Alert }>(`alerts/${id}`, { method: "PATCH", body: patch });
  set({ alerts: (state.alerts ?? []).map((a) => (a.id === id ? j.alert : a)) });
}

export async function deleteAlert(id: number) {
  await api(`alerts/${id}`, { method: "DELETE" });
  set({ alerts: (state.alerts ?? []).filter((a) => a.id !== id) });
}

export async function markRead(ids: number[] | "all") {
  if (!session) return;
  const notes = state.notes ?? [];
  const hit = ids === "all" ? notes.filter((n) => !n.read) : notes.filter((n) => ids.includes(n.id) && !n.read);
  if (ids !== "all" && hit.length === 0) return;
  set({
    notes: notes.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, read: true } : n)),
    unread: ids === "all" ? 0 : Math.max(0, state.unread - hit.length),
  });
  try {
    await api("notes/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
  } catch {
    void refreshNotes();
  }
}

// ------------------------------------------------------------------ phone notifications (web push)

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function checkPush(): Promise<PushState> {
  let p: PushState;
  if (typeof window === "undefined") p = "unknown";
  else if (isIos() && !isStandalone()) p = "ios-install";
  else if (!pushSupported()) p = "unsupported";
  else if (Notification.permission === "denied") p = "denied";
  else if (Notification.permission !== "granted") p = "off";
  else {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      p = sub && localStorage.getItem("sasa-push-owner") === state.address ? "on" : "off";
    } catch {
      p = "off";
    }
  }
  set({ push: p });
  return p;
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks for permission and saves this phone / browser. Call after ensureSession. */
export async function enablePush(): Promise<PushState> {
  const now = await checkPush();
  if (now === "ios-install" || now === "unsupported" || now === "denied") return now;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return checkPush();
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await api("push", { method: "POST", body: { endpoint: j.endpoint, keys: j.keys } });
  try {
    localStorage.setItem("sasa-push-owner", state.address ?? "");
  } catch {}
  return checkPush();
}

export async function disablePush(): Promise<PushState> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await api("push", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    localStorage.removeItem("sasa-push-owner");
  } catch {}
  return checkPush();
}

/** Keeps the server's copy of this device's subscription up to date (they can rotate). */
async function syncPushSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== "granted" || !session) return;
    if (localStorage.getItem("sasa-push-owner") !== state.address) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) {
      localStorage.removeItem("sasa-push-owner");
      void checkPush();
      return;
    }
    const j = sub.toJSON();
    await api("push", { method: "POST", body: { endpoint: j.endpoint, keys: j.keys } });
  } catch {}
}

// ------------------------------------------------------------------ numbers and words

/** "50k", "1.2m", "$60,000", "0.00005" → number (NaN if unreadable). */
export function parseAmount(input: string): number {
  let s = input.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return NaN;
  let mult = 1;
  const last = s.slice(-1);
  if (last === "k") mult = 1e3;
  else if (last === "m") mult = 1e6;
  else if (last === "b") mult = 1e9;
  if (mult !== 1) s = s.slice(0, -1);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = parseFloat(s) * mult;
  return Number.isFinite(n) ? n : NaN;
}

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function fmtCap(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${trim((v / 1e9).toFixed(2))}B`;
  if (v >= 1e6) return `$${trim((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `$${trim((v / 1e3).toFixed(1))}K`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

/** Tiny prices without scientific notation: $0.0₄412 means 0.0000412. */
export function fmtPrice(p: number): string {
  if (!(p > 0)) return "$0";
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  const m = p.toFixed(18).match(/^0\.(0*)(\d+)/);
  if (!m) return `$${p}`;
  const zeros = m[1].length;
  const digits = m[2].slice(0, 4).replace(/0+$/, "") || "0";
  if (zeros >= 4) {
    const sub = "₀₁₂₃₄₅₆₇₈₉";
    return `$0.0${String(zeros).split("").map((d) => sub[+d]).join("")}${digits}`;
  }
  return `$0.${m[1]}${digits}`;
}

/** A plain number to put back into the input box (no exponent). */
export function plainNumber(v: number): string {
  if (v >= 1) return String(Math.round(v));
  const s = Number(v.toPrecision(4)).toFixed(18);
  return trim(s);
}

export function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

export function describeAlert(a: Pick<Alert, "kind" | "dir" | "target">): string {
  if (a.kind === "mc") return `Market cap ${a.dir === "above" ? "rises above" : "falls below"} ${fmtCap(a.target)}`;
  if (a.kind === "price") return `Price ${a.dir === "above" ? "rises above" : "falls below"} ${fmtPrice(a.target)}`;
  if (a.kind === "move") return `${a.dir === "up" ? "Rises" : a.dir === "down" ? "Falls" : "Moves"} ${trim(String(a.target))}% within 1 hour`;
  if (a.kind === "bond") return "Curve reaches 90%";
  return "Coin graduates";
}

/** Market-cap values of this coin's price and market-cap alerts (for lines on the chart). */
export function alertLinesFor(alerts: Alert[] | null, coinId: string): number[] {
  if (!alerts) return [];
  return alerts
    .filter((a) => a.active && a.coinId === coinId && (a.kind === "mc" || a.kind === "price"))
    .map((a) => (a.kind === "mc" ? a.target : a.target * 1e9));
}
