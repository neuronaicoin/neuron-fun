"use client";

/**
 * Price alerts UI: the 🔔 in the header (notifications), the 🔔 next to a
 * coin's name (set / manage alerts) and phone notifications setup.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "./wallet";
import { ConnectButton, Sheet } from "./chrome";
import { CoinAvatar, timeAgo } from "./coins";
import { coinMarketCapUsd } from "./discover";
import { coinHref, type Coin } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import {
  MAX_ALERTS,
  SignInNeeded,
  checkPush,
  createAlert,
  deleteAlert,
  describeAlert,
  disablePush,
  enablePush,
  ensureSession,
  fmtCap,
  fmtPct,
  fmtPrice,
  isIos,
  markRead,
  parseAmount,
  plainNumber,
  refreshAlerts,
  refreshNotes,
  setAlertsAddress,
  updateAlert,
  useAlerts,
  type Alert,
  type AlertDir,
  type AlertKind,
  type Note,
  type PushState,
} from "@/lib/alerts";

// ------------------------------------------------------------------ small pieces

function BellIcon({ size = 18, plus = false }: { size?: number; plus?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {plus && <path d="M12 5.5v4M10 7.5h4" />}
    </svg>
  );
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="absolute -top-1.5 -right-1.5 min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-emerald text-on-accent text-[0.6875rem] font-bold flex items-center justify-center border-2 border-paper">
      {n > 9 ? "9+" : n}
    </span>
  );
}

function Switch({ on, onClick, label, disabled = false }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={"relative w-12 h-7 rounded-full shrink-0 transition-colors disabled:opacity-40 " + (on ? "bg-emerald" : "bg-line")}
    >
      <span className={"absolute top-1 left-1 w-5 h-5 rounded-full bg-white transition-transform " + (on ? "translate-x-5" : "")} />
    </button>
  );
}

// Tiny toast ("Alert set").
let toastSet: ((m: string) => void) | null = null;
export function toast(message: string) {
  toastSet?.(message);
}
function ToastHost() {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  useEffect(() => {
    toastSet = (text) => setMsg({ text, key: Date.now() });
    return () => {
      toastSet = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2200);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return createPortal(
    <div
      key={msg.key}
      role="status"
      className="toast-in fixed left-1/2 -translate-x-1/2 z-[70] bg-ink text-mist font-semibold text-[0.875rem] px-4 py-3 rounded-xl max-w-[calc(100vw-2rem)]"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)" }}
    >
      {msg.text}
    </div>,
    document.body
  );
}

/** Keeps the alert store in step with the logged-in wallet. Mounted once, in the header. */
export function AlertsSync() {
  const { address } = useWallet();
  useEffect(() => setAlertsAddress(address ?? null), [address]);
  return <ToastHost />;
}

/** Signs in to alerts if needed (a free message signature). */
function useSignIn() {
  const { signMessage } = useWallet();
  return () => ensureSession(signMessage);
}

function errorText(e: unknown): string {
  if (e instanceof SignInNeeded) return "Please sign in again.";
  return friendlyError(e);
}

// ------------------------------------------------------------------ header bell

export function HeaderBell() {
  const { address } = useWallet();
  const { unread, ring } = useAlerts();
  const [open, setOpen] = useState<"none" | "drop" | "sheet">("none");
  const [panel, setPanel] = useState<"none" | "alerts" | "push">("none");
  const [ringing, setRinging] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ring) return;
    setRinging(true);
    const t = setTimeout(() => setRinging(false), 900);
    return () => clearTimeout(t);
  }, [ring]);

  // Close the desktop dropdown on an outside click or Escape.
  useEffect(() => {
    if (open !== "drop") return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen("none");
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen("none");
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!address) return null;

  const toggle = () => {
    if (open !== "none") return setOpen("none");
    void refreshNotes();
    setOpen(window.matchMedia("(min-width: 768px)").matches ? "drop" : "sheet");
  };
  const go = (p: "alerts" | "push") => {
    setOpen("none");
    setPanel(p);
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        aria-expanded={open !== "none"}
        className={"relative w-10 h-10 shrink-0 rounded-xl border border-line text-ink-2 hover:text-ink flex items-center justify-center " + (ringing ? "bell-ring" : "")}
      >
        <BellIcon />
        <Badge n={unread} />
      </button>
      {open === "drop" && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-full mt-2 w-[24rem] bg-surface border border-line rounded-2xl shadow-[0_18px_50px_rgba(0,0,0,0.45)] overflow-hidden z-50">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="font-display font-semibold text-[1.0625rem]">Notifications</h2>
            <MarkAllButton />
          </div>
          <NotesList onPick={() => setOpen("none")} />
          <div className="border-t border-line px-4 py-3 flex justify-between gap-2 text-[0.8125rem] font-semibold">
            <button type="button" className="text-emerald" onClick={() => go("alerts")}>Your alerts</button>
            <button type="button" className="text-emerald" onClick={() => go("push")}>Phone notifications</button>
          </div>
        </div>
      )}
      {open === "sheet" && (
        <Sheet title="Notifications" onClose={() => setOpen("none")}>
          <div className="-mx-6 -mt-2">
            <div className="flex justify-end px-6 pb-1">
              <MarkAllButton />
            </div>
            <NotesList onPick={() => setOpen("none")} pad="px-6" />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <button type="button" onClick={() => go("alerts")} className="h-12 rounded-xl border border-line font-semibold text-[0.9375rem]">Your alerts</button>
            <button type="button" onClick={() => go("push")} className="h-12 rounded-xl border border-line font-semibold text-[0.9375rem]">Phone notifications</button>
          </div>
        </Sheet>
      )}
      {panel === "alerts" && <AlertsListSheet onClose={() => setPanel("none")} />}
      {panel === "push" && <PushSheet onClose={() => setPanel("none")} />}
    </div>
  );
}

function MarkAllButton() {
  const { unread } = useAlerts();
  if (!unread) return null;
  return (
    <button type="button" onClick={() => void markRead("all")} className="text-emerald font-semibold text-[0.8125rem] py-1">
      Mark all as read
    </button>
  );
}

const NOTE_ICON: Record<string, string> = { mc: "🔔", price: "🔔", move: "⚡", bond: "🔥", grad: "🎓" };

function NotesList({ onPick, pad = "px-4" }: { onPick: () => void; pad?: string }) {
  const { notes, signedIn } = useAlerts();
  const router = useRouter();
  const open = (n: Note) => {
    void markRead([n.id]);
    onPick();
    try {
      const u = new URL(n.url, location.origin);
      if (u.origin === location.origin) router.push(u.pathname + u.search);
      else location.href = u.href;
    } catch {}
  };
  if (!signedIn || (notes && notes.length === 0)) {
    return (
      <p className={pad + " pt-3 pb-5 text-[0.875rem] leading-relaxed text-ink-2 border-t border-line"}>
        No notifications yet. Tap the bell next to any coin&apos;s name to get told when its market cap, price or curve hits your number.
      </p>
    );
  }
  if (!notes) return <div className={"h-32 mb-4 " + pad}><div className="h-full rounded-xl bg-line/50 animate-pulse" /></div>;
  return (
    <ul className="max-h-[min(26rem,60dvh)] overflow-y-auto">
      {notes.map((n) => (
        <li key={n.id} className="border-t border-line">
          <button type="button" onClick={() => open(n)} className={"w-full text-left flex gap-3 py-3 hover:bg-paper " + pad}>
            <span className="w-9 h-9 rounded-xl bg-emerald-soft flex items-center justify-center shrink-0" aria-hidden="true">
              {NOTE_ICON[n.kind] ?? "🔔"}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-[0.9rem] leading-snug">
                {n.title}
                {!n.read && <span className="inline-block w-2 h-2 rounded-full bg-emerald ml-1.5 align-middle" aria-label="unread" />}
              </span>
              <span className="block text-ink-2 text-[0.8125rem] mt-0.5 leading-snug">{n.body}</span>
              <span className="block text-ink-3 text-[0.75rem] mt-1">{timeAgo(n.createdAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ coin bell

export function CoinAlertButton({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const { address } = useWallet();
  const { alerts } = useAlerts();
  const [view, setView] = useState<"none" | "new" | "list">("none");
  const mine = (alerts ?? []).filter((a) => a.coinId === coin.id && a.active);
  const on = mine.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setView(on ? "list" : "new")}
        aria-label={on ? `Price alerts for this coin: ${mine.length} on` : "Set a price alert"}
        title="Price alerts"
        className={"relative w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 " + (on ? "border-emerald/50 text-emerald" : "border-line text-ink-3 hover:text-ink")}
      >
        <BellIcon size={17} plus />
        <Badge n={mine.length} />
      </button>
      {view !== "none" && !address && (
        <Sheet title="Price alerts" onClose={() => setView("none")}>
          <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
            Log in to get told when ${coin.symbol} hits your number. Alerts are free and can reach your phone even when sasa is closed.
          </p>
          <div className="mt-5">
            <ConnectButton full />
          </div>
        </Sheet>
      )}
      {view === "new" && address && <AlertFormSheet coin={coin} ethUsd={ethUsd} onClose={() => setView("none")} />}
      {view === "list" && address && (
        <AlertsListSheet coin={coin} onClose={() => setView("none")} onNew={() => setView("new")} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ new alert

type FormKind = "mc" | "price" | "move" | "ms";

function AlertFormSheet({ coin, ethUsd, onClose }: { coin: Coin; ethUsd: number | null; onClose: () => void }) {
  const { embedded } = useWallet();
  const { alerts, signedIn, push } = useAlerts();
  const signIn = useSignIn();
  const [kind, setKind] = useState<FormKind>("mc");
  const [value, setValue] = useState("");
  const [moveDir, setMoveDir] = useState<"any" | "up" | "down">("any");
  const [ms, setMs] = useState<"bond" | "grad">("bond");
  const [repeat, setRepeat] = useState(false);
  const [wantPush, setWantPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void checkPush();
    if (signedIn && alerts === null) void refreshAlerts();
  }, [signedIn, alerts]);

  const mc = coinMarketCapUsd(coin, ethUsd);
  const graduated = !!coin.graduatedOn;
  const bondDone = graduated || coin.progress >= 0.9;
  const msChoice: "bond" | "grad" | null = ms === "bond" && !bondDone ? "bond" : !graduated ? "grad" : null;

  const check = useMemo(() => {
    const activeCount = (alerts ?? []).filter((a) => a.active).length;
    if (activeCount >= MAX_ALERTS) return { msg: `You have ${MAX_ALERTS} alerts on. Turn one off to add another.`, err: true, out: null };
    let out: { kind: AlertKind; dir: AlertDir; target: number } | null = null;
    let msg = "";
    let err = false;
    if (kind === "mc" || kind === "price") {
      const cur = mc === null ? null : kind === "mc" ? mc : mc / 1e9;
      const v = parseAmount(value);
      if (cur === null) msg = "Prices are loading…";
      else if (value.trim() === "") msg = kind === "mc" ? "Type a market cap. You can write 50k or 1.2m." : "Type a price in dollars.";
      else if (!(v > 0)) {
        msg = `That isn't a number we can use. Try something like ${kind === "mc" ? "50k" : "0.00005"}.`;
        err = true;
      } else if (Math.abs(v / cur - 1) < 0.005) {
        msg = `That's the current ${kind === "mc" ? "market cap" : "price"}. Pick a number above or below it.`;
        err = true;
      } else if (kind === "mc" && v > 1e12) {
        msg = "That's more than $1T. Pick a smaller number.";
        err = true;
      } else {
        const dir = v > cur ? "above" : "below";
        msg = `You'll get an alert when it ${dir === "above" ? "rises to" : "falls to"} ${kind === "mc" ? fmtCap(v) : fmtPrice(v)} (${fmtPct((v / cur - 1) * 100)} from now).`;
        out = { kind, dir, target: v };
      }
    } else if (kind === "move") {
      const p = parseAmount(value);
      if (value.trim() === "") msg = "Type how big a move you want to hear about.";
      else if (!(p > 0)) {
        msg = "Type a percent, like 20.";
        err = true;
      } else if (p < 2) {
        msg = "Pick 2% or more. Smaller moves happen all the time.";
        err = true;
      } else if (p > 1000) {
        msg = "Pick 1000% or less.";
        err = true;
      } else {
        const t = Math.round(p * 10) / 10;
        out = { kind: "move", dir: moveDir, target: t };
        msg = `You'll get an alert when $${coin.symbol} ${moveDir === "up" ? "rises" : moveDir === "down" ? "falls" : "moves"} ${t}% or more within an hour.`;
      }
    } else if (!msChoice) {
      msg = "This coin has already graduated, so there are no curve alerts left.";
    } else {
      out = { kind: msChoice, dir: "", target: 0 };
      msg = msChoice === "bond" ? "You'll get one alert when the curve is 90% full." : "You'll get one alert when the coin graduates.";
    }
    if (out) {
      const o = out;
      const dup = (alerts ?? []).some(
        (a) => a.active && a.coinId === coin.id && a.kind === o.kind && a.dir === o.dir && Math.abs(a.target - o.target) <= Math.abs(o.target) * 1e-9
      );
      if (dup) return { msg: "You already have this alert.", err: true, out: null };
    }
    return { msg, err, out };
  }, [alerts, kind, value, moveDir, msChoice, mc, coin.id, coin.symbol]);

  const pushOn = push === "on";
  const once = kind === "ms";

  async function turnOnPush() {
    setError("");
    setPushBusy(true);
    try {
      await signIn();
      const p = await enablePush();
      if (p === "on") setWantPush(true);
      else if (p === "denied") setError("Notifications are blocked for this site. Allow them in your browser settings.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPushBusy(false);
    }
  }

  async function save() {
    if (!check.out || busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn();
      await createAlert({
        coinId: coin.id,
        kind: check.out.kind,
        dir: check.out.dir,
        target: check.out.target,
        repeat: once ? false : repeat,
        push: wantPush,
      });
      toast("Alert set");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const chip = (label: string, mult: number) => (
    <button
      key={label}
      type="button"
      disabled={mc === null}
      onClick={() => {
        if (mc === null) return;
        setValue(plainNumber((kind === "mc" ? mc : mc / 1e9) * mult));
      }}
      className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold font-mono hover:border-emerald hover:text-emerald disabled:opacity-40"
    >
      {label}
    </button>
  );

  const tabs: [FormKind, string][] = [
    ["mc", "Market cap"],
    ["price", "Price"],
    ["move", "% move"],
    ["ms", "Curve"],
  ];

  return (
    <Sheet title={`Alert for $${coin.symbol}`} onClose={onClose}>
      <div className="grid grid-cols-4 gap-1 bg-paper border border-line rounded-2xl p-1" role="group" aria-label="Alert type">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setValue("");
              setError("");
            }}
            className={"h-10 px-1 rounded-xl whitespace-nowrap text-[0.75rem] min-[400px]:text-[0.8125rem] font-semibold " + (kind === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {l}
          </button>
        ))}
      </div>

      {(kind === "mc" || kind === "price") && (
        <>
          <div className="flex justify-between mt-4 text-[0.875rem] text-ink-2">
            <span>Now</span>
            <span className="font-mono text-ink">{mc === null ? "—" : kind === "mc" ? fmtCap(mc) : fmtPrice(mc / 1e9)}</span>
          </div>
          <label className="mt-2 flex items-center gap-2 h-14 rounded-2xl bg-paper border border-line px-4 focus-within:border-emerald">
            <span className="text-ink-3 font-mono">$</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder={kind === "mc" ? "e.g. 50k" : "e.g. 0.00005"}
              aria-label={kind === "mc" ? "Target market cap in dollars" : "Target price in dollars"}
              style={{ outline: "none" }}
              className="flex-1 min-w-0 bg-transparent font-mono text-[1.125rem]"
            />
          </label>
          <p className={"text-[0.8125rem] mt-2 min-h-[1.25em] " + (check.err ? "text-danger" : "text-ink-2")} aria-live="polite">{check.msg}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {chip("2x", 2)}
            {chip("+50%", 1.5)}
            {chip("+25%", 1.25)}
            {chip("−25%", 0.75)}
            {chip("−50%", 0.5)}
          </div>
        </>
      )}

      {kind === "move" && (
        <>
          <div className="grid grid-cols-3 gap-1 bg-paper border border-line rounded-2xl p-1 mt-4" role="group" aria-label="Direction">
            {(
              [
                ["any", "Up or down"],
                ["up", "Up"],
                ["down", "Down"],
              ] as const
            ).map(([d, l]) => (
              <button
                key={d}
                type="button"
                aria-pressed={moveDir === d}
                onClick={() => setMoveDir(d)}
                className={"h-10 rounded-xl text-[0.8125rem] font-semibold " + (moveDir === d ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
              >
                {l}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 h-14 rounded-2xl bg-paper border border-line px-4 focus-within:border-emerald">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="e.g. 20"
              aria-label="Percent change within one hour"
              style={{ outline: "none" }}
              className="flex-1 min-w-0 bg-transparent font-mono text-[1.125rem]"
            />
            <span className="text-ink-3 font-mono text-[0.875rem]">% in 1h</span>
          </label>
          <p className={"text-[0.8125rem] mt-2 min-h-[1.25em] " + (check.err ? "text-danger" : "text-ink-2")} aria-live="polite">{check.msg}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {[10, 20, 30, 50, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setValue(String(v))}
                className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold font-mono hover:border-emerald hover:text-emerald"
              >
                {v}%
              </button>
            ))}
          </div>
        </>
      )}

      {kind === "ms" && (
        <>
          <div className="grid gap-2 mt-4" role="group" aria-label="Milestone">
            {(
              [
                ["bond", "🔥", "Curve reaches 90%", bondDone ? (graduated ? "Already graduated" : "Already past 90%") : `Now ${Math.floor(coin.progress * 100)}% full`, bondDone],
                ["grad", "🎓", "Coin graduates", graduated ? "Already graduated" : "When it moves to its locked pool", graduated],
              ] as const
            ).map(([k, icon, title, sub, done]) => {
              const picked = msChoice === k;
              return (
                <button
                  key={k}
                  type="button"
                  disabled={done}
                  aria-pressed={picked}
                  onClick={() => setMs(k)}
                  className={"min-h-14 px-4 py-3 rounded-2xl border text-left flex items-center gap-3 disabled:opacity-50 " + (picked ? "border-emerald bg-emerald-soft" : "border-line")}
                >
                  <span className="text-[1.25rem]" aria-hidden="true">{icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[0.9375rem]">{title}</span>
                    <span className="block text-ink-3 text-[0.8125rem]">{sub}</span>
                  </span>
                  <span className={"w-5 h-5 rounded-full border-2 shrink-0 " + (picked ? "border-emerald bg-emerald shadow-[inset_0_0_0_3px_var(--color-surface)]" : "border-line")} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <p className={"text-[0.8125rem] mt-2 min-h-[1.25em] " + (check.err ? "text-danger" : "text-ink-2")} aria-live="polite">{check.msg}</p>
        </>
      )}

      <div className="mt-4">
        {!once && (
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <div className="font-semibold text-[0.9375rem]">Keep this alert on</div>
              <div className="text-ink-3 text-[0.8125rem] mt-0.5 leading-snug">Tell me every time, not just once. At most one alert every 15 minutes.</div>
            </div>
            <Switch on={repeat} onClick={() => setRepeat(!repeat)} label="Keep this alert on" />
          </div>
        )}
        <div className={"flex items-center justify-between gap-4 py-3 " + (!once ? "border-t border-line" : "")}>
          <div>
            <div className="font-semibold text-[0.9375rem]">Phone notifications</div>
            <div className="text-ink-3 text-[0.8125rem] mt-0.5 leading-snug">{pushHint(push)}</div>
          </div>
          <Switch
            on={pushOn && wantPush}
            disabled={pushBusy || push === "unsupported" || push === "ios-install" || push === "denied"}
            onClick={() => (pushOn ? setWantPush(!wantPush) : void turnOnPush())}
            label="Phone notifications"
          />
        </div>
        {push === "ios-install" && <IosSteps />}
      </div>

      {error && <p className="text-[0.875rem] text-danger mt-2" role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={!check.out || busy}
        className="mt-4 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-45"
      >
        {busy ? "Setting…" : "Set alert"}
      </button>
      {!signedIn && !embedded && (
        <p className="text-[0.75rem] text-ink-3 mt-2 text-center">Your wallet will ask you to sign once. It&apos;s free and sends nothing.</p>
      )}
    </Sheet>
  );
}

function pushHint(p: PushState): string {
  if (p === "on") return "Also send it to this device, even when sasa is closed.";
  if (p === "ios-install") return "On iPhone, add sasa to your Home Screen first.";
  if (p === "denied") return "Blocked for this site. Allow notifications in your browser settings.";
  if (p === "unsupported") return "This browser can't show notifications. Alerts still show in the 🔔.";
  return "Off on this device. Turn on to get alerts when sasa is closed.";
}

function IosSteps() {
  return (
    <div className="rounded-2xl bg-paper border border-line px-4 py-3 text-[0.8125rem] text-ink-2 leading-relaxed">
      Notifications on iPhone need iOS 16.4 or later and sasa on your Home Screen:
      <ol className="list-decimal pl-5 mt-1">
        <li>Tap the Share button in Safari</li>
        <li>Choose Add to Home Screen</li>
        <li>Open sasa from the new icon and turn this on there</li>
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ alerts list

function alertState(a: Alert): string {
  if (a.active) return a.kind === "bond" || a.kind === "grad" || !a.repeat ? "On · once" : "On · every time";
  if (a.firedAt) return `Done · ${timeAgo(a.firedAt)}`;
  return "Off";
}

function AlertsListSheet({ coin, onClose, onNew }: { coin?: Coin; onClose: () => void; onNew?: () => void }) {
  const { alerts, signedIn } = useAlerts();
  const signIn = useSignIn();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (signedIn) void refreshAlerts();
  }, [signedIn]);

  const rows = (alerts ?? []).filter((a) => !coin || a.coinId === coin.id);

  async function run(id: number, fn: () => Promise<void>) {
    setBusyId(id);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Sheet title={coin ? `Alerts for $${coin.symbol}` : "Your alerts"} onClose={onClose}>
      {!signedIn ? (
        <>
          <p className="text-ink-2 text-[0.9375rem] leading-relaxed">Sign in once to see and manage your alerts. It&apos;s free and sends nothing.</p>
          <button
            type="button"
            disabled={signing}
            onClick={async () => {
              setSigning(true);
              setError("");
              try {
                await signIn();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setSigning(false);
              }
            }}
            className="mt-4 h-12 w-full rounded-xl border border-ink font-semibold disabled:opacity-60"
          >
            {signing ? "Signing in…" : "Sign in"}
          </button>
        </>
      ) : alerts === null ? (
        <div className="h-32 rounded-xl bg-line/50 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
          No alerts yet. Tap the bell next to any coin&apos;s name and pick a market cap, price or move.
        </p>
      ) : (
        <ul>
          {rows.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-3 border-t border-line first:border-t-0">
              {!coin && a.coin && <CoinAvatar logo={a.coin.logo} symbol={a.coin.symbol} size={36} />}
              <div className="min-w-0 flex-1">
                {coin ? (
                  <div className={"font-semibold text-[0.9375rem] leading-snug " + (a.active ? "" : "text-ink-3")}>{describeAlert(a)}</div>
                ) : (
                  <Link href={coinHref({ id: a.coinId })} onClick={onClose} className={"block font-semibold text-[0.9375rem] leading-snug " + (a.active ? "" : "text-ink-3")}>
                    {describeAlert(a)}
                  </Link>
                )}
                <div className="text-ink-3 text-[0.8125rem] mt-0.5">
                  {!coin && a.coin ? `$${a.coin.symbol} · ` : ""}
                  {alertState(a)}
                </div>
              </div>
              <Switch
                on={a.active}
                disabled={busyId === a.id}
                onClick={() => void run(a.id, () => updateAlert(a.id, { active: !a.active }))}
                label={a.active ? "Turn alert off" : "Turn alert on"}
              />
              <button
                type="button"
                disabled={busyId === a.id}
                onClick={() =>
                  void run(a.id, async () => {
                    await deleteAlert(a.id);
                    toast("Alert deleted");
                  })
                }
                aria-label="Delete alert"
                className="w-10 h-10 rounded-xl border border-line text-ink-3 hover:text-danger hover:border-danger flex items-center justify-center shrink-0 disabled:opacity-40"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
      {coin && onNew && (
        <button type="button" onClick={onNew} className="mt-5 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark">
          New alert for ${coin.symbol}
        </button>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ phone notifications

function PushSheet({ onClose }: { onClose: () => void }) {
  const { push } = useAlerts();
  const signIn = useSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void checkPush();
  }, []);

  async function on() {
    setBusy(true);
    setError("");
    try {
      await signIn();
      const p = await enablePush();
      if (p === "on") toast("Notifications on");
      else if (p === "denied") setError("Notifications are blocked for this site. Allow them in your browser settings.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function off() {
    setBusy(true);
    await disablePush();
    setBusy(false);
    toast("Notifications off on this device");
  }

  return (
    <Sheet title="Phone notifications" onClose={onClose}>
      {push === "on" ? (
        <>
          <p className="text-ink-2 text-[0.9375rem] leading-relaxed">Notifications are on for this device. Your alerts reach you even when sasa is closed.</p>
          <button type="button" disabled={busy} onClick={() => void off()} className="mt-5 h-12 w-full rounded-xl border border-ink font-semibold disabled:opacity-60">
            Turn off on this device
          </button>
        </>
      ) : push === "ios-install" ? (
        <>
          <p className="text-ink-2 text-[0.9375rem] leading-relaxed mb-3">
            {isIos() ? "On iPhone, notifications work once sasa is on your Home Screen. It takes 10 seconds." : "Add sasa to your Home Screen first."}
          </p>
          <IosSteps />
        </>
      ) : push === "denied" ? (
        <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
          Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then come back here. Your alerts still show in the 🔔.
        </p>
      ) : push === "unsupported" ? (
        <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
          This browser can&apos;t show notifications. Try Chrome, Edge, Firefox or Safari. Your alerts still show in the 🔔.
        </p>
      ) : (
        <>
          <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
            Get your alerts on this device, even when sasa is closed. Free, no email or phone number needed.
          </p>
          <button
            type="button"
            disabled={busy || push === "unknown"}
            onClick={() => void on()}
            className="mt-5 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-50"
          >
            {busy ? "Turning on…" : "Turn on notifications"}
          </button>
          <p className="text-[0.75rem] text-ink-3 mt-2 text-center">Your browser will ask for permission. You can turn it off any time.</p>
        </>
      )}
      {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
    </Sheet>
  );
}
