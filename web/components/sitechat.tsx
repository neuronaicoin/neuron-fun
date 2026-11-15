"use client";

/**
 * sasa Chat: one public room for everyone on the site (/chat/). The last 4 hours of messages,
 * newest at the bottom, scrolled with a finger. Plain text up to 100 characters, no links or
 * ads, 20 messages a day per account (edge/sitechat-api.js checks all of it).
 */
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { Avatar } from "./social";
import { db } from "@/lib/data";
import { authedPost } from "@/lib/alerts";
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { friendlyError, shortAddr } from "@/lib/format";

type Msg = { id: number; author: string; body: string; at: number };
const MAX = 100;
const PER_DAY = 20;
const KEEP_MS = 4 * 3600_000;
// same checks as the server, so people see why before they press Send
const LINK = /(https?:|:\/\/|www\.|\b[a-z0-9-]{2,}\s*\.\s*(com|io|xyz|fun|app|net|org|gg|co|me|ly|to|ai|so)\b|t\.me)/i;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function rowsToMsgs(rows: { id: number; author: string; body: string; created_at: string }[]): Msg[] {
  return rows.map((r) => ({ id: Number(r.id), author: r.author.toLowerCase(), body: r.body, at: Date.parse(r.created_at) }));
}

export function SiteChat() {
  const { address, signMessage } = useWallet();
  const me = address?.toLowerCase() ?? null;
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(0);
  const [sentToday, setSentToday] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastId = useRef(0);

  // the room fills the screen between the top bar and the phone menu
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = box.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--money-bar-bottom")) || 0;
      const phone = window.matchMedia("(max-width: 767px)").matches;
      setH(Math.max(360, window.innerHeight - top - (phone ? nav : 24)));
    };
    fit();
    window.addEventListener("resize", fit);
    const t = setTimeout(fit, 400);
    return () => {
      window.removeEventListener("resize", fit);
      clearTimeout(t);
    };
  }, []);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - KEEP_MS).toISOString();
    const { data, error: e } = await db
      .from("site_chat")
      .select("id,author,body,created_at")
      .gt("created_at", since)
      .order("id", { ascending: false })
      .limit(300);
    if (e) throw new Error(e.message);
    const next = rowsToMsgs((data ?? []) as never[]).reverse();
    setMsgs((cur) => {
      const newest = next.length ? next[next.length - 1].id : 0;
      if (cur && newest > lastId.current && !atBottom.current) setUnread((u) => u + next.filter((m) => m.id > lastId.current).length);
      lastId.current = Math.max(lastId.current, newest);
      return next;
    });
  }, []);

  useEffect(() => {
    void load().catch(() => setMsgs((m) => m ?? []));
    const t = setInterval(() => document.visibilityState === "visible" && void load().catch(() => {}), 3_000);
    return () => clearInterval(t);
  }, [load]);

  // how many of today's 20 this account has left (counted by the server, day in UTC)
  const loadLeft = useCallback(async () => {
    if (!me) return setSentToday(null);
    const { data } = await db.rpc("chat_left", { p_address: me });
    if (typeof data === "number") setSentToday(PER_DAY - data);
  }, [me]);
  useEffect(() => {
    void loadLeft().catch(() => {});
  }, [loadLeft]);

  // keep the newest message in view while the reader is at the bottom
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs, h]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current) setUnread(0);
  };
  const toBottom = () => {
    const el = list.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    atBottom.current = true;
    setUnread(0);
  };

  const profiles = useProfiles(useMemo(() => [...new Set((msgs ?? []).map((m) => m.author))], [msgs]));
  const online = useMemo(() => new Set((msgs ?? []).filter((m) => Date.now() - m.at < 15 * 60_000).map((m) => m.author)).size, [msgs]);

  const hint = text && LINK.test(text) ? "Links aren't allowed in the chat." : "";

  async function send() {
    const body = text.replace(/\s+/g, " ").trim();
    if (!body || busy || hint) return;
    setBusy(true);
    setError("");
    try {
      await authedPost(signMessage, "chat", { body });
      setText("");
      atBottom.current = true;
      await load();
      void loadLeft().catch(() => {});
    } catch (e) {
      setError(friendlyError(e));
      void loadLeft().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const left = sentToday === null ? null : Math.max(0, PER_DAY - sentToday);

  return (
    <div ref={box} className="max-w-2xl mx-auto w-full md:pt-4 md:px-4">
      <section
        aria-label="sasa Chat"
        className="relative flex flex-col min-h-0 overflow-hidden bg-surface md:rounded-3xl md:border md:border-line md:shadow-sm"
        style={{ height: h ?? "70vh" }}
      >
        {/* header */}
        <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-line" style={{ background: "linear-gradient(100deg, rgba(255,107,26,.12), rgba(255,107,26,0) 60%)" }}>
          <span className="w-10 h-10 rounded-2xl grid place-items-center text-white text-[1.125rem] shrink-0" style={{ background: "linear-gradient(135deg,#ff8a3d,#ff6b1a)" }} aria-hidden="true">
            💬
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display font-extrabold text-[1.125rem] leading-tight">sasa Chat</h1>
            <p className="text-[0.75rem] text-ink-3 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" aria-hidden="true" />
              {online > 0 ? `${online} talking in the last 15 min` : "Live"} · last 4 hours
            </p>
          </div>
          <span className="shrink-0 text-[0.6875rem] text-ink-3 text-right leading-tight hidden min-[380px]:block">
            No links · No ads
            <br />
            {MAX} characters
          </span>
        </header>

        {/* messages: scroll with a finger */}
        <div
          ref={list}
          onScroll={onScroll}
          data-no-ptr
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 sm:px-4 py-3 flex flex-col gap-1"
          style={{ WebkitOverflowScrolling: "touch" }}
          aria-live="polite"
        >
          {msgs === null ? (
            <div className="flex flex-col gap-3 py-2" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={"h-10 rounded-2xl shimmer " + (i % 2 ? "w-1/2 self-end" : "w-2/3")} />
              ))}
            </div>
          ) : msgs.length === 0 ? (
            <div className="m-auto text-center px-6">
              <div className="text-[2.25rem]" aria-hidden="true">👋</div>
              <p className="font-semibold mt-2">No messages in the last 4 hours</p>
              <p className="text-[0.875rem] text-ink-3 mt-1">Say hi, share what you&apos;re watching. Be the first.</p>
            </div>
          ) : (
            <>
              <p className="text-center text-[0.6875rem] text-ink-3 py-1">Messages disappear after 4 hours</p>
              {msgs.map((m, i) => {
                const prev = msgs[i - 1];
                const grouped = !!prev && prev.author === m.author && m.at - prev.at < 3 * 60_000;
                const mine = m.author === me;
                const p = profiles.get(m.author);
                const name = p ? displayName(p) : shortAddr(m.author);
                const href = p ? profileHref(p) : `/u/${m.author}/`;
                return (
                  <div key={m.id} className={"chat-in flex gap-2 min-w-0 " + (mine ? "flex-row-reverse" : "") + (grouped ? "" : " mt-2")}>
                    {!mine && (
                      <span className="w-8 shrink-0">
                        {!grouped && (
                          <Link href={href} aria-label={name}>
                            {p ? <Avatar profile={p} size={32} /> : <span className="block w-8 h-8 rounded-full bg-line" />}
                          </Link>
                        )}
                      </span>
                    )}
                    <div className={"min-w-0 max-w-[80%] flex flex-col " + (mine ? "items-end" : "items-start")}>
                      {!grouped && !mine && (
                        <Link href={href} className="text-[0.75rem] font-semibold text-ink-2 px-1 mb-0.5 truncate max-w-full">
                          {name}
                        </Link>
                      )}
                      <div
                        className={
                          "px-3.5 py-2 text-[0.9375rem] leading-snug break-words [overflow-wrap:anywhere] " +
                          (mine ? "text-white rounded-2xl rounded-br-md" : "bg-night text-ink rounded-2xl rounded-bl-md")
                        }
                        style={mine ? { background: "linear-gradient(135deg,#ff8a3d,#ff6b1a)" } : undefined}
                      >
                        {m.body}
                        <span className={"ml-2 align-bottom text-[0.625rem] " + (mine ? "text-white/75" : "text-ink-3")}>{clock(m.at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {unread > 0 && (
          <button
            type="button"
            onClick={toBottom}
            className="absolute left-1/2 -translate-x-1/2 bottom-[5.25rem] h-9 px-4 rounded-full text-white text-[0.8125rem] font-bold shadow-lg"
            style={{ background: "#ff6b1a" }}
          >
            {unread} new ↓
          </button>
        )}

        {/* write */}
        <div className="shrink-0 border-t border-line px-3 py-2.5 bg-surface">
          {address ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="flex-1 min-w-0 relative">
                <input
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value.slice(0, MAX));
                    setError("");
                  }}
                  placeholder={left === 0 ? "That's 20 for today. Back tomorrow." : "Say something…"}
                  disabled={left === 0}
                  aria-label="Your message"
                  maxLength={MAX}
                  enterKeyHint="send"
                  className="w-full h-12 rounded-2xl bg-paper border border-line pl-4 pr-14 text-[1rem] focus:border-[#ff6b1a] outline-none disabled:opacity-60"
                />
                <span className={"absolute right-3 top-1/2 -translate-y-1/2 text-[0.6875rem] tabular-nums " + (text.length >= MAX ? "text-danger font-semibold" : "text-ink-3")}>
                  {MAX - text.length}
                </span>
              </div>
              <button
                type="submit"
                disabled={busy || !text.trim() || !!hint || left === 0}
                aria-label="Send"
                className="h-12 w-12 rounded-2xl grid place-items-center text-white shrink-0 disabled:opacity-40"
                style={{ background: "linear-gradient(135deg,#ff8a3d,#ff6b1a)" }}
              >
                {busy ? (
                  "…"
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12 L19 5 L14 19 L11.5 13 Z" />
                  </svg>
                )}
              </button>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.875rem] text-ink-2">Log in to join the chat.</p>
              <div className="shrink-0">
                <ConnectButton />
              </div>
            </div>
          )}
          <div className="flex justify-between gap-3 mt-1.5 px-1 text-[0.6875rem] min-h-[1rem]">
            <span className={hint || error ? "text-danger" : "text-ink-3"} role={hint || error ? "alert" : undefined}>
              {hint || error || "Be nice. No links, no ads, no contract addresses."}
            </span>
            {address && left !== null && <span className="text-ink-3 shrink-0 tabular-nums">{left}/{PER_DAY} left today</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
