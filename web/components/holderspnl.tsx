"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/social";
import { compactUsd } from "@/lib/format";
import { db } from "@/lib/data";
import { onTrade } from "@/lib/live";
import { fetchCoinPnl, type WalletPnl } from "@/lib/pnl";
import { type RaceCoin } from "@/lib/race";
import { displayName, profileHref, useProfiles } from "@/lib/social";

const money = (v: number) => (Math.abs(v) >= 1000 ? compactUsd(Math.abs(v)) : `$${Math.abs(v).toFixed(2)}`);

export function signedUsd(v: number) {
  return `${v >= 0 ? "+" : "−"}${money(v)}`;
}

/** "×4.2" when the money grew more than 2.5 times, else "+38%". */
export function gainLabel(pct: number | null) {
  if (pct === null) return "";
  if (pct >= 150) return `×${(1 + pct / 100).toFixed(pct >= 900 ? 0 : 1)}`;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%`;
}

function ago(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Everyone in the coin: what they hold now, how far up or down they are, the market cap they got
 * in at, and the last thing they said in the coin's chat.
 */
export function HoldersPnl({ coin }: { coin: RaceCoin }) {
  const [rows, setRows] = useState<WalletPnl[] | null>(null);
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [all, setAll] = useState(false);
  const [onlyUp, setOnlyUp] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchCoinPnl(coin)
        .then((r) => alive && setRows(r))
        .catch(() => alive && setRows((prev) => prev ?? []));
    const loadNotes = () =>
      db
        .from("race_chat")
        .select("author,body,id")
        .eq("coin_id", coin.id.toLowerCase())
        .order("id", { ascending: false })
        .limit(200)
        .then(({ data }) => {
          if (!alive) return;
          const m = new Map<string, string>();
          for (const r of (data ?? []) as { author: string; body: string }[]) {
            const k = r.author.toLowerCase();
            if (!m.has(k)) m.set(k, r.body);
          }
          setNotes(m);
        });
    load();
    void loadNotes();
    const t = setInterval(load, 15_000);
    const stop = onTrade((s) => s.coinId.toLowerCase() === coin.id && [2000, 5000].forEach((d) => setTimeout(load, d)));
    return () => {
      alive = false;
      clearInterval(t);
      stop();
    };
    // the coin object is refreshed every few seconds; its price changes are picked up on the next load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id]);

  const list = (rows ?? []).filter((r) => !onlyUp || r.pnl > 0);
  const shown = all ? list : list.slice(0, 12);
  const profiles = useProfiles(shown.map((r) => r.trader));
  const holding = (rows ?? []).filter((r) => r.held > 0).length;
  const up = (rows ?? []).filter((r) => r.pnl > 0).length;

  if (rows === null) return <div className="h-40 mt-3 rounded-2xl bg-night animate-pulse" />;
  if (!rows.length) return <p className="py-6 text-ink-3 text-[0.875rem]">Nobody has bought yet. Be the first.</p>;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 pt-3 pb-1 text-[0.8125rem]">
        <span className="text-ink-2">
          <b className="text-ink">{holding}</b> holding · <b className="text-up">{up}</b> in profit
        </span>
        <button
          type="button"
          onClick={() => setOnlyUp((v) => !v)}
          aria-pressed={onlyUp}
          className={"ml-auto h-8 px-3 rounded-full border text-[0.8125rem] font-semibold " + (onlyUp ? "bg-up/10 border-up text-up" : "border-line text-ink-2")}
        >
          In profit
        </button>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((r) => {
          const p = profiles.get(r.trader) ?? { address: r.trader, username: null, color: "#e7e5e0", emoji: "", avatar: null };
          const note = notes.get(r.trader);
          const isCreator = r.trader === coin.creator.toLowerCase();
          const tone = r.pnl >= 0 ? "text-up" : "text-danger";
          return (
            <li key={r.trader} className="py-3">
              <Link href={profileHref(p)} className="flex gap-3 items-start min-w-0">
                <Avatar profile={p} size={38} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="font-semibold text-[0.9375rem] truncate">{displayName(p)}</span>
                    {isCreator && <span className="shrink-0 text-[0.6875rem] font-bold uppercase tracking-wide text-emerald-dark">creator</span>}
                    <span className="ml-auto shrink-0 font-bold tabular-nums text-[0.9375rem]">{r.held > 0 ? money(r.value) : "sold"}</span>
                  </div>
                  <div className="flex items-baseline gap-2 text-[0.8125rem] min-w-0">
                    <span className="text-ink-3 truncate">
                      {r.entryMc ? `in at ${compactUsd(r.entryMc)} MC` : "no buys"} · {ago(r.lastTs)}
                    </span>
                    <span className={"ml-auto shrink-0 font-semibold tabular-nums " + tone}>
                      {signedUsd(r.pnl)} {r.pnlPct !== null && <span className="opacity-80">({gainLabel(r.pnlPct)})</span>}
                    </span>
                  </div>
                  {note && <p className="mt-1.5 text-[0.875rem] text-ink-2 border-l-2 border-emerald pl-2 line-clamp-2 break-words">{note}</p>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {list.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 h-10 rounded-full border border-line text-[0.875rem] font-semibold text-ink-2">
          Show all {list.length}
        </button>
      )}
    </div>
  );
}
