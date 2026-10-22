"use client";

/**
 * Trend Radar: the hottest new meme coins across DEXs right now and the themes behind
 * them. Tapping a theme asks the AI for an original coin on that theme.
 * Sits inside the "Create with AI" box on the launch page.
 */
import { useEffect, useState } from "react";
import { fetchTrends, networkLabel, type Trends } from "@/lib/trends";
import { compactUsd } from "@/lib/format";

function ago(ts: number) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function TrendRadar({ onTheme, disabled = false, showCoins = true }: { onTheme: (theme: string) => void; disabled?: boolean; showCoins?: boolean }) {
  const [t, setT] = useState<Trends | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchTrends()
      .then((x) => live && setT(x))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (failed) return null;

  return (
    <div className="flex flex-col gap-2 min-w-0" aria-label="Trending now">
      <div className="flex items-center gap-2">
        <span className="relative flex w-2 h-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#ff6b1a] opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full w-2 h-2 bg-[#ff6b1a]" />
        </span>
        <span className="text-[0.8125rem] font-bold text-ink">Trending right now</span>
        <span className="ml-auto text-[0.6875rem] text-ink-3">{t ? `across all chains · ${ago(t.at)}` : " "}</span>
      </div>

      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 h-8">
        {t
          ? t.themes.map((w) => (
              <button
                key={w}
                type="button"
                disabled={disabled}
                aria-pressed={picked === w}
                onClick={() => {
                  setPicked(w);
                  onTheme(w);
                }}
                className={
                  "h-8 px-3 shrink-0 rounded-full border text-[0.8125rem] font-semibold whitespace-nowrap disabled:opacity-50 " +
                  (picked === w ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink hover:border-ink-3")
                }
              >
                🔥 {w}
              </button>
            ))
          : [0, 1, 2, 3, 4].map((i) => <span key={i} className="shimmer h-8 w-20 shrink-0 rounded-full" />)}
      </div>

      {showCoins && (
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 h-11">
          {t
            ? t.coins.slice(0, 8).map((c) => (
                <div key={c.network + c.symbol} className="shrink-0 flex items-center gap-2 rounded-xl border border-line bg-paper px-2.5 h-11">
                  {c.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.image} alt="" width={24} height={24} loading="lazy" className="w-6 h-6 rounded-full object-cover bg-line shrink-0" />
                  ) : (
                    <span className="w-6 h-6 rounded-full bg-line shrink-0 flex items-center justify-center text-[0.625rem] font-bold text-ink-2">{c.symbol.slice(0, 2)}</span>
                  )}
                  <span className="leading-tight">
                    <span className="block font-bold text-[0.75rem] truncate max-w-[6.5rem]">${c.symbol}</span>
                    <span className="block text-[0.625rem] text-ink-3 whitespace-nowrap">
                      {networkLabel(c.network)} · {compactUsd(c.vol24)}
                      {c.change24 !== null && (
                        <span className={c.change24 >= 0 ? "text-up" : "text-danger"}>
                          {" "}
                          {c.change24 >= 0 ? "+" : ""}
                          {Math.round(c.change24)}%
                        </span>
                      )}
                    </span>
                  </span>
                </div>
              ))
            : [0, 1, 2, 3].map((i) => <span key={i} className="shimmer h-11 w-32 shrink-0 rounded-xl" />)}
        </div>
      )}
    </div>
  );
}
