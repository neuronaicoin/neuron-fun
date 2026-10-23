"use client";

/**
 * Copy a whale: when the trader opens a futures position, the same side opens on the user's
 * account with their own amount and leverage cap; when the trader closes, it closes
 * (indexer/copytrade.mjs, within about a minute). One approval on Hyperliquid, once.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ConnectButton, Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { sessionToken } from "@/lib/alerts";
import { copyAgent, myCopies, startCopy, stopCopy, type CopySettings } from "@/lib/copytrade";
import { friendlyError } from "@/lib/format";
import { PERPS_TRADING, geoExempt, perpsAllowedHere } from "@/lib/perps";
import { usePerpsTrade } from "@/lib/perpstrade";
import { showToast } from "@/lib/toast";

// the user's copies, shared by every button on the page
let copies: Map<string, CopySettings> | null = null;
let loadedFor: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
function setCopies(list: CopySettings[]) {
  copies = new Map(list.map((c) => [c.whale.toLowerCase(), c]));
  emit();
}

function useCopies() {
  const w = useWallet();
  const me = w.address?.toLowerCase() ?? null;
  const snap = useSyncExternalStore(subscribe, () => copies, () => null);
  useEffect(() => {
    if (loadedFor !== me) {
      copies = null;
      loadedFor = me;
      emit();
    }
    // no signature asked just to look: only with a session already open
    if (!me || !sessionToken() || copies) return;
    void myCopies(w.signMessage)
      .then((r) => loadedFor === me && setCopies(r.copies))
      .catch(() => {});
  }, [me, w.signMessage]);
  return snap;
}

const noop = async () => {};

export function CopyButton({ whale, name, compact = false }: { whale: string; name?: string | null; compact?: boolean }) {
  const set = useCopies();
  const mine = set?.get(whale.toLowerCase()) ?? null;
  const on = !!mine?.active;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          (compact ? "h-8 px-3 text-[0.8125rem] " : "h-10 px-4 text-[0.875rem] ") +
          "rounded-full font-semibold shrink-0 " +
          (on ? "border border-emerald text-emerald bg-emerald-soft" : "bg-emerald text-on-accent")
        }
      >
        {on ? "Copying" : "Copy"}
      </button>
      {open && <CopySheet whale={whale} name={name ?? null} mine={mine} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopySheet({ whale, name, mine, onClose }: { whale: string; name: string | null; mine: CopySettings | null; onClose: () => void }) {
  const w = useWallet();
  const trade = usePerpsTrade(noop);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [per, setPer] = useState(String(mine?.per_trade ?? 50));
  const [lev, setLev] = useState(mine?.max_lev ?? 5);
  const [closes, setCloses] = useState(mine?.copy_closes ?? true);
  const [useStop, setUseStop] = useState(mine ? mine.stop_loss !== null : true);
  const [stop, setStop] = useState(String(mine?.stop_loss ?? 100));
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const who = name || `Trader ${whale.slice(0, 6)}…${whale.slice(-4)}`;
  const on = !!mine?.active;

  useEffect(() => {
    let alive = true;
    void perpsAllowedHere().then((ok) => alive && setAllowed(ok));
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const r = await myCopies(w.signMessage).catch(() => null);
    if (r) setCopies(r.copies);
  }, [w.signMessage]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const amount = Number(per);
      if (!(amount >= 10)) throw new Error("Per trade is at least $10.");
      const stopN = useStop ? Number(stop) : null;
      if (useStop && !(stopN! > 0)) throw new Error("Enter your stop as a dollar amount.");
      setStep("Getting ready…");
      const agent = await copyAgent(w.signMessage);
      await trade.approveCopy(agent, setStep);
      setStep("Saving…");
      await startCopy(w.signMessage, { whale, per_trade: amount, max_lev: lev, copy_closes: closes, stop_loss: stopN });
      await refresh();
      showToast({ kind: "ok", title: on ? "Copy settings saved" : `Copying ${who}`, body: `Their next opens copy with $${amount} each, up to ${lev}x.` });
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };
  const stopIt = async () => {
    setBusy(true);
    setErr(null);
    try {
      await stopCopy(w.signMessage, whale);
      await refresh();
      showToast({ kind: "ok", title: "Stopped copying", body: "Positions already open stay open; close them in Futures." });
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (sel: boolean) => "h-11 rounded-xl border font-semibold text-[0.9375rem] " + (sel ? "border-ink ring-1 ring-ink" : "border-line text-ink-2");
  const toggle = (v: boolean, set: (v: boolean) => void, label: string) => (
    <button type="button" role="switch" aria-checked={v} onClick={() => set(!v)} className="flex items-center justify-between gap-3 py-1 text-left">
      <span className="text-[0.9375rem]">{label}</span>
      <span className={"relative w-11 h-6 rounded-full shrink-0 transition-colors " + (v ? "bg-emerald" : "bg-line")}>
        <span className={"absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all " + (v ? "left-[1.375rem]" : "left-0.5")} />
      </span>
    </button>
  );

  return (
    <Sheet title={`Copy ${who}`} onClose={onClose}>
      {allowed === false && !geoExempt(w.address) ? (
        <p className="text-ink-2">Copy trading uses futures, which aren&apos;t offered where you are.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[0.875rem] text-ink-2">
            When {who} opens a futures position, the same side opens for you within about a minute. When they close, yours closes. Uses your futures balance.
          </p>
          {mine && !mine.active && mine.paused_why && mine.paused_why !== "stopped" && (
            <p className="text-[0.8125rem] text-warn-ink">
              Copying stopped: {mine.paused_why === "stop reached" ? "your stop was hit." : mine.paused_why === "not approved" ? "the approval was removed." : mine.paused_why}. Start again below.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-ink-3">Per trade (your money in)</span>
            <div className="grid grid-cols-4 gap-2">
              {["25", "50", "100", "250"].map((v) => (
                <button key={v} type="button" aria-pressed={per === v} onClick={() => setPer(v)} className={chip(per === v)}>
                  ${v}
                </button>
              ))}
            </div>
            <label className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
              <input
                inputMode="decimal"
                value={per}
                onChange={(e) => setPer(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                aria-label="Per trade in dollars"
                className="w-full h-12 rounded-xl border border-line bg-paper pl-8 pr-4 text-[1rem] outline-none focus:border-ink-3"
              />
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-ink-3">Max leverage (their leverage, never more than this)</span>
            <div className="grid grid-cols-4 gap-2">
              {[3, 5, 10, 20].map((v) => (
                <button key={v} type="button" aria-pressed={lev === v} onClick={() => setLev(v)} className={chip(lev === v)}>
                  {v}x
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            {toggle(closes, setCloses, "Also copy closes")}
            {toggle(useStop, setUseStop, "Stop if my copied positions lose more than")}
            {useStop && (
              <label className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
                <input
                  inputMode="decimal"
                  value={stop}
                  onChange={(e) => setStop(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                  aria-label="Stop in dollars"
                  className="w-full h-12 rounded-xl border border-line bg-paper pl-8 pr-4 text-[1rem] outline-none focus:border-ink-3"
                />
              </label>
            )}
          </div>
          {err && <p className="text-[0.8125rem] text-danger">{err}</p>}
          {!w.address ? (
            <ConnectButton full />
          ) : (
            <button
              type="button"
              disabled={busy || !PERPS_TRADING || (allowed === null && !geoExempt(w.address))}
              onClick={() => void start()}
              className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
            >
              {busy ? (step ?? "Working…") : on ? "Save" : "Start copying"}
            </button>
          )}
          {on && (
            <button type="button" disabled={busy} onClick={() => void stopIt()} className="h-11 rounded-full border border-line font-semibold disabled:opacity-50">
              Stop copying
            </button>
          )}
          <p className="text-[0.75rem] text-ink-3 text-center">
            You approve once; sasa&apos;s copy key can trade your futures account but can never move money out. Copying can lose money; past results don&apos;t repeat.
          </p>
        </div>
      )}
    </Sheet>
  );
}
