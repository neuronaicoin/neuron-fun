"use client";

import { useEffect, useState } from "react";
import { fetchCoinThreads, forumBoardUrl, type ForumThread } from "@/lib/forum";
import type { Coin } from "@/lib/data";
import { shortAddr } from "@/lib/format";
import { timeAgo } from "./coins";

/** Latest threads from the coin's forum board, with a link to the board. */
export function ForumCard({ coin }: { coin: Coin }) {
  const [threads, setThreads] = useState<ForumThread[] | null>(null);
  const board = forumBoardUrl(coin);
  useEffect(() => {
    let alive = true;
    fetchCoinThreads(coin, 3)
      .then((t) => alive && setThreads(t))
      .catch(() => alive && setThreads([]));
    return () => {
      alive = false;
    };
  }, [coin]);

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="font-display font-semibold text-[1.125rem]">Forum</h2>
        <a href={board} className="text-[0.875rem] font-semibold text-emerald">
          Open ${coin.symbol} forum
        </a>
      </div>
      {threads === null ? (
        <div className="h-16 rounded-xl bg-line/50 animate-pulse" />
      ) : threads.length === 0 ? (
        <p className="text-[0.875rem] text-ink-2 leading-relaxed">
          No threads yet. Holders of ${coin.symbol} can start the first one.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {threads.map((t) => (
            <li key={t.id}>
              <a href={t.url} className="block py-2.5 hover:text-emerald">
                <span className="block font-semibold text-[0.9375rem] leading-snug">{t.title}</span>
                <span className="block text-[0.8125rem] text-ink-3 mt-0.5">
                  {t.replies} {t.replies === 1 ? "reply" : "replies"} · <span className="font-mono">{shortAddr(t.author)}</span> · {timeAgo(t.lastPostAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
