"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "./wallet";
import { Avatar } from "./social";
import { db } from "@/lib/data";
import { authedPost } from "@/lib/alerts";
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { friendlyError, shortAddr } from "@/lib/format";
import { racePhase, type RaceCoin } from "@/lib/race";

type Msg = { id: number; author: string; body: string; createdAt: number };
const OPEN_AFTER_MS = 15 * 60_000;

/**
 * Live chat on a race page: anyone signed in can talk while the five minutes run (and a
 * quarter of an hour after). Short plain text, no links; the API limits how fast people write.
 */
export function RaceChat({ coin, now }: { coin: RaceCoin; now: number }) {
  const { address, signMessage } = useWallet();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const phase = racePhase(coin, now);
  const closeAt = (coin.decidedAt ?? coin.endsAt) + OPEN_AFTER_MS;
  const open = phase !== "decided" || now < closeAt;

  const load = useCallback(async () => {
    const { data } = await db.from("race_chat").select("id,author,body,created_at").eq("coin_id", coin.id.toLowerCase()).order("id", { ascending: false }).limit(60);
    setMsgs(
      ((data ?? []) as { id: number; author: string; body: string; created_at: string }[])
        .map((r) => ({ id: Number(r.id), author: r.author, body: r.body, createdAt: Date.parse(r.created_at) }))
        .reverse()
    );
  }, [coin.id]);

  useEffect(() => {
    void load().catch(() => setMsgs((m) => m ?? []));
    if (!open) return;
    const t = setInterval(() => document.visibilityState === "visible" && void load().catch(() => {}), 3_000);
    return () => clearInterval(t);
  }, [load, open]);

  // keep the newest message in view, unless the reader scrolled up
  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const profiles = useProfiles((msgs ?? []).map((m) => m.author));

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      await authedPost(signMessage, "racechat", { coinId: coin.id, body });
      setText("");
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open && msgs !== null && msgs.length === 0) return null;

  return (
    <section className="rounded-2xl border border-line p-4 sm:p-5 flex flex-col gap-3 min-w-0" aria-label="Race chat">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[1.125rem] font-bold flex items-center gap-2">
          Race chat
          {phase === "racing" && <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" aria-hidden="true" />}
        </h2>
        <span className="text-[0.75rem] text-ink-3">{open ? "Be nice. No links." : "Closed after the race"}</span>
      </div>

      <ul ref={list} className="flex flex-col gap-2 max-h-72 overflow-y-auto overscroll-contain pr-1" aria-live="polite">
        {msgs === null ? (
          <li className="h-10 rounded-xl bg-line/50 animate-pulse" />
        ) : msgs.length === 0 ? (
          <li className="text-[0.875rem] text-ink-3">No messages yet. Say which chain you're backing.</li>
        ) : (
          msgs.map((m) => {
            const p = profiles.get(m.author.toLowerCase());
            const isCreator = m.author.toLowerCase() === coin.creator.toLowerCase();
            return (
              <li key={m.id} className="flex gap-2 min-w-0">
                <a href={p ? profileHref(p) : `/u/${m.author}/`} className="shrink-0 mt-0.5">
                  {p ? <Avatar profile={p} size={24} /> : <span className="block w-6 h-6 rounded-full bg-line" />}
                </a>
                <p className="text-[0.875rem] leading-snug min-w-0 break-words">
                  <a href={p ? profileHref(p) : `/u/${m.author}/`} className="font-semibold mr-1.5">
                    {p ? displayName(p) : shortAddr(m.author)}
                  </a>
                  {isCreator && <span className="mr-1.5 px-1.5 rounded-full text-[0.6875rem] font-bold bg-warn-bg text-warn-ink">Creator</span>}
                  <span className="text-ink-2">{m.body}</span>
                </p>
              </li>
            );
          })
        )}
      </ul>

      {open &&
        (address ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 200))}
              placeholder="Which chain are you backing?"
              aria-label="Your message"
              maxLength={200}
              className="flex-1 min-w-0 h-11 rounded-xl bg-paper border border-line px-3.5 text-[0.9375rem] focus:border-ink-3 outline-none"
            />
            <button type="submit" disabled={busy || !text.trim()} className="h-11 px-4 rounded-xl bg-ink text-mist font-semibold text-[0.875rem] disabled:opacity-45 shrink-0">
              {busy ? "…" : "Send"}
            </button>
          </form>
        ) : (
          <p className="text-[0.8125rem] text-ink-3">Log in to join the chat.</p>
        ))}
      {error && (
        <p className="text-[0.8125rem] text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
