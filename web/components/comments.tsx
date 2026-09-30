"use client";

/**
 * Comments under a coin. Only holders can write; everyone can read.
 * Comments live in the coin's pinned "comments" thread on its forum board,
 * so search engines also find them on the server-rendered forum page.
 */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { Avatar } from "./social";
import { timeAgo } from "./coins";
import { db, type Coin } from "@/lib/data";
import { ensureSession, useAlerts } from "@/lib/alerts";
import { forumBoardUrl, slugify } from "@/lib/forum";
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { friendlyError } from "@/lib/format";

type Comment = { id: number; author: string; body: string; shareBps: number; createdAt: string; hidden: string | null };

function shareText(bps: number) {
  const p = bps / 100;
  return p >= 10 ? `${p.toFixed(0)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="nofollow ugc noopener" className="text-emerald underline break-all">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function CoinComments({ coin, bare = false, max }: { coin: Coin; bare?: boolean; max?: number }) {
  const [showAll, setShowAll] = useState(false);
  const { address, signMessage } = useWallet();
  const { signedIn } = useAlerts();
  const [thread, setThread] = useState<{ id: number; title: string } | null | undefined>(undefined);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [can, setCan] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data: t } = await db.from("forum_threads_public").select("id,title").eq("board", coin.id).eq("kind", "comments").limit(1);
    const th = ((t ?? []) as { id: number; title: string }[])[0] ?? null;
    setThread(th);
    if (!th) {
      setComments([]);
      return;
    }
    const { data } = await db
      .from("forum_posts_public")
      .select("id,author,body,share_bps,created_at,hidden")
      .eq("thread_id", th.id)
      .order("id", { ascending: false })
      .limit(40);
    setComments(
      ((data ?? []) as { id: number; author: string; body: string; share_bps: number; created_at: string; hidden: string | null }[]).map((r) => ({
        id: Number(r.id),
        author: r.author,
        body: r.body,
        shareBps: r.share_bps,
        createdAt: r.created_at,
        hidden: r.hidden,
      }))
    );
  }, [coin.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  // Can this wallet comment? (holders of the coin, on any chain)
  useEffect(() => {
    setCan(null);
    if (!address || !signedIn) return;
    const raw = localStorage.getItem(`sasa-session:${address.toLowerCase()}`);
    const token = raw ? (JSON.parse(raw) as { token?: string }).token : null;
    if (!token) return;
    fetch(`/api/forum/me?board=${encodeURIComponent(coin.id)}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((j: { canPost?: boolean }) => setCan(!!j.canPost))
      .catch(() => setCan(null));
  }, [address, signedIn, coin.id]);

  const profiles = useProfiles((comments ?? []).map((c) => c.author));

  async function send() {
    setBusy(true);
    setError("");
    try {
      await ensureSession(signMessage);
      const raw = localStorage.getItem(`sasa-session:${(address ?? "").toLowerCase()}`);
      const token = raw ? (JSON.parse(raw) as { token?: string }).token : null;
      const r = await fetch("/api/forum/comments", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ coinId: coin.id, body: text }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Couldn't post. Try again.");
      setText("");
      toast("Comment posted");
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const threadUrl = thread ? `${forumBoardUrl(coin)}${thread.id}-${slugify(thread.title, 70) || "thread"}/` : forumBoardUrl(coin);
  const allVisible = (comments ?? []).filter((c) => !c.hidden);
  // Terminal shows the newest few; the rest are one tap away.
  const visible = max && !showAll ? allVisible.slice(0, max) : allVisible;
  const hiddenCount = allVisible.length - visible.length;

  return (
    <section className={bare ? "" : "rounded-3xl border border-line bg-surface p-4 sm:p-5"} aria-labelledby="comments-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="comments-h" className="font-display font-semibold text-[1.125rem]">
          Comments {visible.length > 0 && <span className="text-ink-3 font-normal text-[0.9375rem]">· {visible.length}{visible.length >= 40 ? "+" : ""}</span>}
        </h2>
        <a href={threadUrl} className="text-[0.8125rem] font-semibold text-emerald">Open in forum</a>
      </div>

      {/* Composer */}
      <div className="mt-3">
        {!address ? (
          <p className="text-[0.875rem] text-ink-2">Log in to comment. Only ${coin.symbol} holders can write here.</p>
        ) : can === false ? (
          <p className="text-[0.875rem] text-ink-2">Only ${coin.symbol} holders can comment. Buy any amount on any chain to join in.</p>
        ) : (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 1000))}
              rows={2}
              placeholder={signedIn ? `Say something about $${coin.symbol}…` : `Holders of $${coin.symbol} can comment here…`}
              aria-label="Your comment"
              style={{ outline: "none" }}
              className="w-full rounded-2xl bg-paper border border-line px-3.5 py-3 text-[0.9375rem] focus:border-emerald resize-y"
            />
            <div className="flex items-center justify-between gap-3 mt-2">
              <span className="text-[0.75rem] text-ink-3">{text.length}/1000 · be kind, no price promises</span>
              <button
                type="button"
                disabled={busy || text.trim().length < 2}
                onClick={() => void send()}
                className="h-10 px-5 rounded-xl bg-emerald text-on-accent font-bold text-[0.875rem] hover:bg-emerald-dark disabled:opacity-45"
              >
                {busy ? "Posting…" : "Post"}
              </button>
            </div>
            {error && <p className="text-[0.8125rem] text-danger mt-2" role="alert">{error}</p>}
          </div>
        )}
      </div>

      {/* List */}
      {comments === null || thread === undefined ? (
        <div className="h-16 mt-4 rounded-2xl bg-line/50 animate-pulse" />
      ) : visible.length === 0 ? (
        <p className="text-[0.875rem] text-ink-3 mt-4">No comments yet. Holders can start the conversation.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {visible.map((c) => {
            const p = profiles.get(c.author.toLowerCase());
            return (
              <li key={c.id} className="py-3 flex gap-3">
                <a href={p ? profileHref(p) : `/u/${c.author}/`} className="shrink-0">
                  {p ? <Avatar profile={p} size={34} /> : <span className="block w-[34px] h-[34px] rounded-full bg-line" />}
                </a>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[0.8125rem] flex-wrap">
                    <a href={p ? profileHref(p) : `/u/${c.author}/`} className="font-semibold">{p ? displayName(p) : c.author.slice(0, 6)}</a>
                    {c.author.toLowerCase() === coin.creator.toLowerCase() && (
                      <span className="px-1.5 h-5 rounded-full text-[0.6875rem] font-bold bg-warn-bg text-warn-ink flex items-center">Creator</span>
                    )}
                    {c.shareBps > 0 && (
                      <span className="px-1.5 h-5 rounded-full text-[0.6875rem] font-bold bg-emerald-soft text-emerald flex items-center" title="Share of the supply held when posting">
                        {shareText(c.shareBps)}
                      </span>
                    )}
                    <span className="text-ink-3">{timeAgo(c.createdAt)}</span>
                  </div>
                  <p className="text-[0.9375rem] leading-relaxed mt-1 whitespace-pre-wrap break-words">{linkify(c.body)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full h-10 rounded-xl border border-line text-[0.8125rem] font-semibold text-ink-2 hover:border-emerald/60"
        >
          Show all {allVisible.length} comments
        </button>
      )}
    </section>
  );
}
