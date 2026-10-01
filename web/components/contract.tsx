"use client";

/**
 * The coin's contract address (CA) with a copy button, shown on coin pages.
 * A coin launched on several chains has one address per chain: the chip
 * switches between them. Copying works on iPhone too (old Safari fallback).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "./alerts";

export type ContractEntry = { key: string; label: string; color: string; address: string; explorer?: string | null };

/** Copies text; falls back to a hidden text box where the clipboard API is missing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* try the fallback below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ContractAddress({ entries, className = "" }: { entries: ContractEntry[]; className?: string }) {
  const list = entries.filter((e) => /^0x[0-9a-fA-F]{40}$/.test(e.address));
  const [i, setI] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (list.length === 0) return null;
  const cur = list[Math.min(i, list.length - 1)];
  const many = list.length > 1;

  async function copy() {
    const ok = await copyText(cur.address);
    if (!ok) {
      toast("Couldn't copy. Press and hold the address to select it.");
      return;
    }
    toast("Contract address copied");
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={"flex items-center gap-1.5 sm:gap-2 max-w-full w-fit rounded-xl border border-line bg-paper pl-2.5 pr-1 py-1 " + className}>
      <span className="text-[0.6875rem] font-semibold text-ink-3 shrink-0">CA</span>
      <button
        type="button"
        onClick={() => many && setI((v) => (v + 1) % list.length)}
        disabled={!many}
        title={many ? "Show the address on another chain" : cur.label}
        aria-label={many ? `${cur.label}. Switch chain` : cur.label}
        className="h-6 px-2 rounded-full text-[0.6875rem] font-semibold text-white flex items-center gap-1 shrink-0 disabled:cursor-default"
        style={{ background: cur.color }}
      >
        {cur.label}
        {many && <span aria-hidden="true" className="opacity-80">⇄</span>}
      </button>
      {cur.explorer ? (
        <a
          href={cur.explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[0.8125rem] text-ink-2 hover:text-ink truncate min-w-0 select-all"
          title={cur.address}
        >
          {short(cur.address)}
        </a>
      ) : (
        <span className="font-mono text-[0.8125rem] text-ink-2 truncate min-w-0 select-all" title={cur.address}>
          {short(cur.address)}
        </span>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy contract address"
        className={
          "h-8 px-2.5 rounded-lg border text-[0.75rem] font-semibold flex items-center gap-1.5 shrink-0 " +
          (copied ? "border-up text-up" : "border-line bg-surface text-ink hover:border-emerald/60")
        }
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
          </svg>
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
