"use client";

import { useSyncExternalStore } from "react";
import { getServerToast, getToast, hideToast, subscribeToast } from "@/lib/toast";

/** The big trade notice: top of the screen, green for a buy, red for a sell, gone after a few seconds. */
export function TradeToast() {
  const t = useSyncExternalStore(subscribeToast, getToast, getServerToast);
  if (!t) return null;
  const tone =
    t.kind === "buy" || t.kind === "ok" ? "bg-up text-white" : t.kind === "sell" ? "bg-danger text-white" : "bg-warn-bg text-warn-ink border border-warn-ink/30";
  const icon = t.kind === "error" ? "!" : "✓";
  return (
    <div className="fixed inset-x-0 z-[80] flex justify-center px-3 pointer-events-none" style={{ top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}>
      <div
        key={t.id}
        role="status"
        aria-live="polite"
        className={"toast-in pointer-events-auto w-full max-w-md rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3 " + tone}
      >
        {t.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.logo} alt="" className="w-11 h-11 rounded-full object-cover bg-white/20 shrink-0" />
        ) : (
          <span className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center text-[1.375rem] font-bold shrink-0" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-[1.0625rem] leading-tight">{t.title}</span>
          {t.body && <span className="block text-[0.8125rem] opacity-90 mt-0.5 leading-snug">{t.body}</span>}
          {t.href && (
            <a href={t.href} target="_blank" rel="noopener noreferrer" className="inline-block text-[0.8125rem] font-semibold underline mt-0.5 opacity-95">
              {t.hrefLabel ?? "View transaction"}
            </a>
          )}
        </span>
        <button type="button" onClick={hideToast} aria-label="Close" className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center shrink-0 text-[1.125rem]">
          ×
        </button>
      </div>
    </div>
  );
}
