"use client";

/**
 * "Who bought": the first wallets into a coin, what they paid and what they
 * still hold. Creator and linked wallets (ones that passed the coin between
 * each other) are tagged, so a bundled launch is easy to spot.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Coin } from "@/lib/data";
import { fetchFirstBuyers, type FirstBuyer } from "@/lib/holders";
import { compactUsd } from "@/lib/format";
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { useWallet } from "./wallet";

const FIRST = 5;

const pct = (v: number) => (v <= 0 ? "Sold" : v < 0.0001 ? "<0.01%" : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);

export function WhoBought({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const { address } = useWallet();
  const [rows, setRows] = useState<FirstBuyer[] | null>(null);
  const [error, setError] = useState(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchFirstBuyers(coin, ethUsd)
        .then((r) => {
          if (!alive) return;
          setRows(r);
          setError(false);
        })
        .catch(() => alive && setError(true));
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id, ethUsd]);

  const profiles = useProfiles(useMemo(() => (rows ?? []).map((r) => r.addr), [rows]));
  const creator = coin.creator.toLowerCase();
  const me = address?.toLowerCase() ?? "";

  if (error && !rows) return null;
  const shown = rows ? (all ? rows : rows.slice(0, FIRST)) : [];
  const stillIn = rows ? rows.reduce((s, r) => s + r.share, 0) : 0;
  const soldAll = rows ? rows.filter((r) => r.share <= 0).length : 0;
  const linked = rows ? rows.filter((r) => r.linked).length : 0;

  return (
    <section className="border border-line rounded-xl p-4 sm:p-5 min-w-0" aria-label="Who bought">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display font-semibold text-[1.125rem]">Who bought</h2>
        <span className="text-[0.75rem] text-ink-3">First {rows?.length || 30} buyers</span>
      </div>

      {rows === null ? (
        <div className="mt-3 grid gap-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="shimmer block h-9 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[0.875rem] text-ink-3 mt-3">No buys yet.</p>
      ) : (
        <>
          <p className="text-[0.8125rem] text-ink-2 mt-1.5">
            They still hold <b className="font-semibold text-ink font-mono">{pct(stillIn) === "Sold" ? "0%" : pct(stillIn)}</b> of the supply
            {soldAll > 0 && ` · ${soldAll} sold everything`}
            {linked > 0 && ` · ${linked} linked`}
          </p>
          <div className="mt-3 -mx-1 overflow-x-auto">
            <table className="w-full border-collapse text-[0.875rem]">
              <thead>
                <tr className="text-[0.75rem] text-ink-3 text-right">
                  <th className="font-medium text-left py-2 px-1">Wallet</th>
                  <th className="font-medium py-2 px-1">Bought</th>
                  <th className="font-medium py-2 px-1">Holds</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const p = profiles.get(r.addr);
                  const name = p ? displayName(p) : `${r.addr.slice(0, 6)}…${r.addr.slice(-4)}`;
                  return (
                    <tr key={r.addr} className="border-t border-line">
                      <td className="py-2 px-1 max-w-0 w-full">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-ink-3 font-mono text-[0.75rem] w-5 shrink-0">{i + 1}</span>
                          <Link href={profileHref(p ?? { address: r.addr, username: null })} className="font-mono truncate hover:underline">
                            {name}
                          </Link>
                          {r.addr === creator && <Tag>Creator</Tag>}
                          {r.addr === me && <Tag>You</Tag>}
                          {r.linked && <Tag warn>Linked</Tag>}
                        </span>
                      </td>
                      <td className="py-2 px-1 text-right font-mono whitespace-nowrap">{compactUsd(r.boughtUsd)}</td>
                      <td className={"py-2 px-1 text-right font-mono whitespace-nowrap " + (r.share <= 0 ? "text-ink-3" : "")}>{pct(r.share)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > FIRST && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="mt-2 w-full h-10 rounded-xl border border-line text-[0.8125rem] font-semibold text-ink-2 hover:bg-night"
            >
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
          {linked > 0 && (
            <p className="text-[0.75rem] text-ink-3 mt-2">Linked wallets sent this coin to each other. Often that&apos;s one person using several wallets.</p>
          )}
        </>
      )}
    </section>
  );
}

function Tag({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span className={"shrink-0 h-5 px-1.5 rounded text-[0.6875rem] font-semibold flex items-center " + (warn ? "bg-warn-bg text-warn-ink" : "bg-night-2 text-ink-2")}>
      {children}
    </span>
  );
}
