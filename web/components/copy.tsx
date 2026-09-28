"use client";

/**
 * Copy trading pieces used on profiles, the You page and /copy/:
 * the Copy button and its setup sheet, the "let followers copy me" switch,
 * and the Copyable badge.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./wallet";
import { Sheet } from "./chrome";
import { toast } from "./alerts";
import { useAlerts } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";
import { displayName, type Profile } from "@/lib/social";
import { fetchCopyBoard, fetchCopying, saveCopy, setAllowCopy, type CopyMode, type CopySetting } from "@/lib/copy";
import { fetchPrices } from "@/lib/price";
import { usd } from "./coins";

// My copy settings, shared by every Copy button on the page.
let mine: Map<string, CopySetting> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function useMyCopies(): Map<string, CopySetting> | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return mine;
}

async function loadMine(sign: (m: string) => Promise<string>) {
  const { copying } = await fetchCopying(sign);
  mine = new Map(copying.map((c) => [c.trader, c]));
  changed();
}

export function CopyBadge({ className = "" }: { className?: string }) {
  return (
    <span className={"inline-flex items-center h-6 px-2 rounded-full bg-emerald-soft text-emerald text-[0.6875rem] font-bold " + className}>
      Copyable
    </span>
  );
}

/** "Copy" on a trader's profile. Only shown for traders who allow it. */
export function CopyButton({ profile, big = false }: { profile: Profile; big?: boolean }) {
  const { address, signMessage } = useWallet();
  const { signedIn } = useAlerts();
  const copies = useMyCopies();
  const [open, setOpen] = useState(false);
  const target = profile.address.toLowerCase();

  // Already signed in: find out quietly whether we copy them (no signature asked).
  useEffect(() => {
    if (address && signedIn && mine === null) loadMine(signMessage).catch(() => {});
  }, [address, signedIn, signMessage]);

  if (!profile.allowCopy || (address && address.toLowerCase() === target)) return null;
  const on = !!copies?.get(target);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (!address) {
            toast("Log in to copy traders");
            return;
          }
          try {
            if (mine === null) await loadMine(signMessage);
            setOpen(true);
          } catch (e) {
            toast(friendlyError(e));
          }
        }}
        className={
          (big ? "h-11 px-6 text-[0.9375rem] " : "h-9 px-4 text-[0.8125rem] ") +
          "rounded-xl font-bold shrink-0 " +
          (on ? "border border-emerald text-emerald" : "bg-emerald text-on-accent hover:bg-emerald-dark")
        }
      >
        {on ? "Copying" : "Copy"}
      </button>
      {open && <CopySheet profile={profile} current={copies?.get(target) ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopySheet({ profile, current, onClose }: { profile: Profile; current: CopySetting | null; onClose: () => void }) {
  const { signMessage } = useWallet();
  const [mode, setMode] = useState<CopyMode>(current?.mode ?? "fixed");
  const [amount, setAmount] = useState(String(current?.amount ?? 10));
  const [sells, setSells] = useState(current?.copySells ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = displayName(profile);
  const n = Number(amount.replace(",", "."));

  async function save(on: boolean) {
    setError("");
    if (on && !(n > 0)) {
      setError("Enter an amount above 0.");
      return;
    }
    setBusy(true);
    try {
      await saveCopy(signMessage, profile.address, on ? { mode, amount: n, copySells: sells } : null);
      const m = new Map(mine ?? []);
      if (on) m.set(profile.address.toLowerCase(), { trader: profile.address.toLowerCase(), mode, amount: n, copySells: sells });
      else m.delete(profile.address.toLowerCase());
      mine = m;
      changed();
      toast(on ? (current ? "Saved" : `Copying ${name}. You'll get a signal when they trade.`) : `Stopped copying ${name}`);
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Copy ${name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-paper" role="radiogroup" aria-label="How much to copy">
        {(
          [
            ["fixed", "Same amount each time"],
            ["pct", "Share of theirs"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              setMode(m);
              setAmount(m === "fixed" ? "10" : "20");
            }}
            className={"h-10 rounded-xl text-[0.8125rem] font-semibold " + (mode === m ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="mt-3 flex items-center h-14 px-4 rounded-2xl border border-line bg-paper focus-within:border-emerald">
        {mode === "fixed" && <span className="font-display text-[1.375rem] text-ink-3 mr-1">$</span>}
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
          inputMode="decimal"
          aria-label={mode === "fixed" ? "Dollars per signal" : "Percent of their trade"}
          className="w-full bg-transparent font-display text-[1.5rem] outline-none"
        />
        {mode === "pct" && <span className="font-display text-[1.375rem] text-ink-3 ml-1">%</span>}
      </label>
      <p className="text-[0.8125rem] text-ink-3 mt-2">
        {mode === "fixed"
          ? "Each signal suggests buying this many dollars."
          : `If ${name} buys $100, ${n > 0 ? n : 20}% suggests ${usd(n > 0 ? n : 20, 2)}.`}{" "}
        You can change it on every signal.
      </p>
      <label className="mt-4 flex items-center justify-between gap-4 cursor-pointer">
        <span>
          <span className="font-semibold block">Copy their sells too</span>
          <span className="text-[0.8125rem] text-ink-3">When they sell part of a coin you hold, you get a signal to sell the same share.</span>
        </span>
        <input type="checkbox" checked={sells} onChange={(e) => setSells(e.target.checked)} className="w-6 h-6 accent-[var(--color-emerald)] shrink-0" />
      </label>
      <p className="text-[0.75rem] text-ink-3 mt-4">
        Nothing is ever bought for you. Every signal waits for you to tap Apply or Reject, and expires after 24 hours.
      </p>
      {error && (
        <p role="alert" className="text-danger text-[0.8125rem] mt-3">
          {error}
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void save(true)} className="mt-4 w-full h-12 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-50">
        {busy ? "…" : current ? "Save" : "Start copying"}
      </button>
      {current && (
        <button type="button" disabled={busy} onClick={() => void save(false)} className="mt-2 w-full h-12 rounded-2xl border border-line font-semibold text-ink-2 disabled:opacity-50">
          Stop copying
        </button>
      )}
    </Sheet>
  );
}

/** The "let followers copy my trades" switch, with how it's going. */
export function AllowCopyCard({ profile, onChange }: { profile: Profile; onChange: () => void }) {
  const { address, signMessage } = useWallet();
  const [on, setOn] = useState(profile.allowCopy);
  const [busy, setBusy] = useState(false);
  const [earned, setEarned] = useState<number | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  useEffect(() => setOn(profile.allowCopy), [profile.allowCopy]);
  useEffect(() => {
    if (!on) return;
    Promise.all([fetchCopyBoard(3650), fetchPrices()])
      .then(([rows, prices]) => {
        const me = rows.find((r) => r.trader === profile.address.toLowerCase());
        setApplied(me?.applied ?? 0);
        setEarned(me && prices?.ETH ? (me.earned / 1e18) * prices.ETH : 0);
      })
      .catch(() => {});
  }, [on, profile.address]);

  if (!address || address.toLowerCase() !== profile.address.toLowerCase()) return null;

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await setAllowCopy(signMessage, profile.address, next);
      setOn(next);
      toast(next ? "Followers can now copy your trades" : "Copying turned off");
      onChange();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span>
          <span className="font-semibold block">Let followers copy my trades</span>
          <span className="text-[0.8125rem] text-ink-3">
            They get a signal when you buy or sell and choose whether to follow it. Trades in coins you created are never sent.
          </span>
        </span>
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
          aria-label="Let followers copy my trades"
          className="w-6 h-6 accent-[var(--color-emerald)] shrink-0"
        />
      </label>
      {on && (
        <>
          <div className="grid grid-cols-3 gap-2 mt-4 text-center">
            <div className="rounded-2xl bg-paper p-3">
              <div className="font-display font-semibold text-[1.125rem]">{profile.copiers}</div>
              <div className="text-[0.75rem] text-ink-3">copying you</div>
            </div>
            <div className="rounded-2xl bg-paper p-3">
              <div className="font-display font-semibold text-[1.125rem]">{applied ?? "…"}</div>
              <div className="text-[0.75rem] text-ink-3">copies applied</div>
            </div>
            <div className="rounded-2xl bg-paper p-3">
              <div className="font-display font-semibold text-[1.125rem]">{earned === null ? "…" : usd(earned, 2)}</div>
              <div className="text-[0.75rem] text-ink-3">earned from copies</div>
            </div>
          </div>
          <p className="text-[0.75rem] text-ink-3 mt-3">You earn 10% of sasa&apos;s fee on every trade copied from you. Payouts start at mainnet.</p>
        </>
      )}
      <Link href="/copy/" className="mt-4 inline-block text-[0.875rem] font-bold text-emerald">
        Your copy signals
      </Link>
    </div>
  );
}
