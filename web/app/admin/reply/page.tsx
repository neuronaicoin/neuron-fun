"use client";

/**
 * Reply helper (admins): paste a link to a post on X (or open it from the "sasa reply" bookmark),
 * get 3 short reply ideas, tap one: X opens with the reply written, the admin presses Reply.
 * Nothing is posted from here; X's rules don't allow automated replies to other people.
 */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { authedPost } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";

type Answer = { author: string; handle: string; text: string; tweetId: string; replies: string[] };

const BOOKMARK = "javascript:(()=>{window.open('https://sasapad.fun/admin/reply/?u='+encodeURIComponent(location.href),'sasareply','width=560,height=760')})()";

export default function ReplyHelper() {
  const w = useWallet();
  const [url, setUrl] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [a, setA] = useState<Answer | null>(null);
  const [edits, setEdits] = useState<string[]>([]);

  const run = useCallback(
    async (link: string, more = "") => {
      if (!link.trim()) return;
      setBusy(true);
      setErr(null);
      try {
        const j = await authedPost<Answer>(w.signMessage, "ai/reply", { url: link.trim(), extra: more });
        setA(j);
        setEdits(j.replies);
      } catch (e) {
        setErr(friendlyError(e));
      } finally {
        setBusy(false);
      }
    },
    [w.signMessage]
  );

  // opened from the bookmark: ?u=<the post's link>
  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("u");
    if (u) setUrl(u);
  }, []);
  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("u");
    if (u && w.address) void run(u);
    // once, when the wallet is there
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.address]);

  const intent = (text: string) => `https://x.com/intent/post?in_reply_to=${a?.tweetId}&text=${encodeURIComponent(text)}`;

  return (
    <main className="max-w-[560px] mx-auto px-4 py-6 flex flex-col gap-4">
      <h1 className="text-[1.5rem] font-bold">Reply ideas</h1>
      {!w.address ? (
        <ConnectButton full />
      ) : (
        <>
          {/* phone: copy the post's link in X (Share → Copy link), then one tap here */}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              try {
                const t = (await navigator.clipboard.readText()).trim();
                setUrl(t);
                void run(t, "");
              } catch {
                setErr("Couldn't read the copied link. Paste it in the box below.");
              }
            }}
            className="h-14 rounded-2xl bg-emerald text-on-accent font-bold text-[1.125rem] disabled:opacity-50"
          >
            {busy ? "Writing…" : "Paste link & write"}
          </button>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://x.com/…/status/…"
              className="flex-1 h-12 rounded-xl border border-line bg-paper px-4 text-[1rem] outline-none focus:border-ink-3"
            />
            <button type="button" disabled={busy || !url} onClick={() => void run(url, extra)} className="h-12 px-5 rounded-xl bg-emerald text-on-accent font-bold disabled:opacity-50">
              {busy ? "…" : "Write"}
            </button>
          </div>
          {err && <p className="text-danger text-[0.875rem]">{err}</p>}
          {a && (
            <>
              <div className="rounded-xl border border-line p-3 text-[0.875rem] text-ink-2 whitespace-pre-wrap">
                <b className="text-ink">@{a.handle}</b> {a.text || "(only an image)"}
              </div>
              {edits.map((r, i) => (
                <div key={i} className="rounded-xl border border-line p-3 flex flex-col gap-2">
                  <textarea
                    value={r}
                    onChange={(e) => setEdits((x) => x.map((y, j) => (j === i ? e.target.value : y)))}
                    rows={3}
                    className="w-full bg-transparent outline-none text-[1rem] resize-none"
                  />
                  <a href={intent(r)} target="_blank" rel="noreferrer" className="self-end h-10 px-5 rounded-full bg-ink text-paper font-bold flex items-center">
                    Reply on X →
                  </a>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder="optional: what the image shows, or an angle you want"
                  className="flex-1 h-11 rounded-xl border border-line bg-paper px-3 text-[0.875rem] outline-none"
                />
                <button type="button" disabled={busy} onClick={() => void run(url, extra)} className="h-11 px-4 rounded-xl border border-line font-semibold disabled:opacity-50">
                  New ideas
                </button>
              </div>
            </>
          )}
          <div className="mt-4 rounded-xl border border-dashed border-line p-3 text-[0.8125rem] text-ink-3 flex flex-col gap-2">
            <span>Drag this button to your bookmarks bar. On any post on X, tap it.</span>
            {/* a bookmarklet: React would refuse a javascript: href, so it is set on the element directly */}
            <a
              ref={(el) => {
                if (el) el.setAttribute("href", BOOKMARK);
              }}
              onClick={(e) => e.preventDefault()}
              className="self-start h-9 px-4 rounded-full bg-emerald text-on-accent font-bold flex items-center cursor-grab"
            >
              sasa reply
            </a>
          </div>
        </>
      )}
    </main>
  );
}
