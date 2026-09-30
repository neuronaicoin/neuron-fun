"use client";

/** Admin: the help desk inbox (messages from /help), answered by email. */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { authedGet, authedPost } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";

type Ticket = {
  id: number;
  created_at: string;
  name: string;
  email: string;
  message: string;
  wallet: string | null;
  page: string | null;
  status: "open" | "answered" | "closed";
  reply: string | null;
  replied_at: string | null;
};

export function HelpInbox() {
  const { signMessage } = useWallet();
  const [filter, setFilter] = useState<"open" | "answered" | "closed" | "">("open");
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [mail, setMail] = useState(true);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const j = await authedGet<{ tickets: Ticket[]; mail: boolean }>(signMessage, `help/list${filter ? `?status=${filter}` : ""}`);
      setRows(j.tickets);
      setMail(j.mail);
      setError("");
    } catch (e) {
      setError(friendlyError(e));
      setRows([]);
    }
  }, [signMessage, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reply(t: Ticket) {
    const text = (draft[t.id] ?? "").trim();
    if (!text) return;
    setBusy(t.id);
    try {
      const r = await authedPost<{ ok: boolean; emailed: boolean; reason?: string }>(signMessage, "help/reply", { id: t.id, reply: text });
      if (r.emailed) toast(`Reply emailed to ${t.email}`);
      else {
        // No email service yet: open the reply in the admin's own mail app.
        toast("Saved. Email isn't set up, so your mail app opens to send it.");
        window.location.href = `mailto:${t.email}?subject=${encodeURIComponent(`Re: your message to sasa (#${t.id})`)}&body=${encodeURIComponent(`Hi ${t.name},\n\n${text}\n\n— sasa support`)}`;
      }
      setDraft((d) => ({ ...d, [t.id]: "" }));
      await load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(0);
    }
  }

  async function close(t: Ticket) {
    setBusy(t.id);
    try {
      await authedPost(signMessage, "help/close", { id: t.id });
      await load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(0);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display font-semibold text-[1.125rem]">Help inbox</h2>
        <div className="flex gap-1.5" role="group" aria-label="Show">
          {(["open", "answered", "closed", ""] as const).map((f) => (
            <button
              key={f || "all"}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={"h-8 px-3 rounded-full border text-[0.75rem] font-semibold " + (filter === f ? "border-emerald text-ink" : "border-line text-ink-3")}
            >
              {f ? f[0].toUpperCase() + f.slice(1) : "All"}
            </button>
          ))}
        </div>
      </div>
      {!mail && <p className="mt-2 text-[0.75rem] text-ink-3">Email isn’t set up yet (RESEND_API_KEY): replies open in your own mail app.</p>}
      {error && <p className="mt-3 text-danger text-[0.875rem]">{error}</p>}
      {rows === null ? (
        <div className="shimmer h-24 rounded-2xl mt-3" />
      ) : !rows.length ? (
        <p className="mt-3 text-[0.875rem] text-ink-3">Nothing here.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {rows.map((t) => (
            <li key={t.id} className="rounded-2xl border border-line bg-paper p-3 sm:p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  #{t.id} · {t.name} <span className="text-ink-3 font-normal">&lt;{t.email}&gt;</span>
                </span>
                <span className="text-[0.75rem] text-ink-3">
                  {new Date(t.created_at).toLocaleString()} · {t.status}
                </span>
              </div>
              {t.wallet && <div className="text-[0.6875rem] text-ink-3 font-mono mt-0.5">{t.wallet}</div>}
              <p className="mt-2 text-[0.875rem] whitespace-pre-wrap break-words">{t.message}</p>
              {t.reply && (
                <div className="mt-2 rounded-xl bg-emerald-soft p-3 text-[0.8125rem] whitespace-pre-wrap break-words">
                  <span className="font-semibold">Your reply{t.replied_at ? ` · ${new Date(t.replied_at).toLocaleString()}` : ""}:</span> {t.reply}
                </div>
              )}
              {t.status !== "closed" && (
                <div className="mt-3 grid gap-2">
                  <textarea
                    value={draft[t.id] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                    rows={3}
                    placeholder={t.reply ? "Write another reply…" : "Write a reply…"}
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-[0.9375rem] outline-none focus:border-emerald"
                  />
                  <div className="flex gap-2 justify-end">
                    <button type="button" disabled={busy === t.id} onClick={() => void close(t)} className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold disabled:opacity-40">
                      Close
                    </button>
                    <button
                      type="button"
                      disabled={busy === t.id || !(draft[t.id] ?? "").trim()}
                      onClick={() => void reply(t)}
                      className="h-9 px-4 rounded-xl bg-emerald text-on-accent text-[0.8125rem] font-bold disabled:opacity-40"
                    >
                      {busy === t.id ? "Sending…" : "Send reply"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
