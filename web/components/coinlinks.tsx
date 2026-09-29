"use client";

/** X / Telegram / website for a coin: the input fields, the icons, and the creator's editor. */
import { useEffect, useState } from "react";
import { cleanTelegram, cleanWebsite, cleanX, telegramUrl, xUrl } from "@/lib/links";
import { saveLinks, useCoinLinks, type CoinLinks } from "@/lib/coinlinks";
import { friendlyError } from "@/lib/format";
import { useWallet } from "./wallet";
import { Sheet } from "./chrome";
import { toast } from "./alerts";

export type LinkDraft = { x: string; telegram: string; website: string };
export const EMPTY_DRAFT: LinkDraft = { x: "", telegram: "", website: "" };

/** Which of the three fields don't parse (empty is fine). */
export function draftProblems(d: LinkDraft): { x: boolean; telegram: boolean; website: boolean } {
  return { x: !cleanX(d.x).ok, telegram: !cleanTelegram(d.telegram).ok, website: !cleanWebsite(d.website).ok };
}
export const draftToLinks = (d: LinkDraft): CoinLinks => ({
  x: cleanX(d.x).value,
  telegram: cleanTelegram(d.telegram).value,
  website: cleanWebsite(d.website).value,
});
export const linksToDraft = (l: CoinLinks | null): LinkDraft => ({
  x: l?.x ?? "",
  telegram: l?.telegram ?? "",
  website: l?.website?.replace(/^https:\/\//, "") ?? "",
});

const box = "flex items-center h-11 sm:h-12 rounded-xl sm:rounded-2xl border bg-paper focus-within:border-emerald overflow-hidden";

/** The three optional inputs (Create page and the editor). */
export function LinkFields({ value, onChange }: { value: LinkDraft; onChange: (d: LinkDraft) => void }) {
  const bad = draftProblems(value);
  const field = (
    key: keyof LinkDraft,
    icon: React.ReactNode,
    prefix: string,
    placeholder: string,
    label: string,
    error: string
  ) => (
    <label className="grid gap-1 min-w-0">
      <span className="sr-only">{label}</span>
      <span className={box + " " + (bad[key] ? "border-danger" : "border-line")}>
        <span className="pl-2.5 sm:pl-3.5 pr-1 sm:pr-1.5 text-ink-2 shrink-0" aria-hidden="true">
          {icon}
        </span>
        {/* The prefix only fits on wider screens; on phones the icon says it all. */}
        <span className="hidden sm:inline text-ink-3 text-[0.875rem] shrink-0">{prefix}</span>
        <input
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          onBlur={() => {
            // Pasted a full link? Keep just the part that goes after the prefix.
            const c = key === "x" ? cleanX(value.x) : key === "telegram" ? cleanTelegram(value.telegram) : cleanWebsite(value.website);
            if (c.ok && c.value) {
              const shown = key === "website" ? c.value.replace(/^https:\/\//, "") : c.value;
              if (shown !== value[key]) onChange({ ...value, [key]: shown });
            }
          }}
          placeholder={placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          maxLength={key === "website" ? 120 : 60}
          aria-invalid={bad[key]}
          className="flex-1 min-w-0 w-full h-full bg-transparent pr-2 sm:pr-3 text-ink text-[1rem] placeholder:text-ink-3/60 outline-none"
        />
      </span>
      {bad[key] && <span className="text-[0.6875rem] sm:text-[0.75rem] text-danger leading-tight">{error}</span>}
    </label>
  );
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:gap-2.5 items-start">
      {field("x", <XIcon />, "x.com/", "handle", "X profile", "Letters, numbers, _")}
      {field("telegram", <TgIcon />, "t.me/", "group", "Telegram", "Use t.me/name")}
      {field("website", <WebIcon />, "https://", "site.com", "Website", "Not a web address")}
    </div>
  );
}

/** Icon links under a coin's name; the creator also gets an edit button. */
export function CoinLinksRow({ coinId, creator, className = "" }: { coinId: string; creator: string; className?: string }) {
  const links = useCoinLinks(coinId);
  const { address } = useWallet();
  const [editing, setEditing] = useState(false);
  const mine = !!address && address.toLowerCase() === creator.toLowerCase();
  const has = !!links && (links.x || links.telegram || links.website);
  if (!links || (!has && !mine)) return null;
  const pill = "inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-line bg-surface text-[0.8125rem] font-semibold hover:border-emerald/60";
  return (
    <div className={"flex flex-wrap items-center gap-1.5 " + className}>
      {links.x && (
        <a href={xUrl(links.x)} target="_blank" rel="noopener noreferrer nofollow" className={pill} aria-label={`X: @${links.x}`}>
          <XIcon /> <span className="hidden sm:inline max-w-[9rem] truncate">@{links.x}</span>
        </a>
      )}
      {links.telegram && (
        <a href={telegramUrl(links.telegram)} target="_blank" rel="noopener noreferrer nofollow" className={pill} aria-label="Telegram">
          <TgIcon /> <span className="hidden sm:inline">Telegram</span>
        </a>
      )}
      {links.website && (
        <a href={links.website} target="_blank" rel="noopener noreferrer nofollow" className={pill} aria-label={`Website: ${links.website}`}>
          <WebIcon /> <span className="hidden sm:inline max-w-[10rem] truncate">{links.website.replace(/^https:\/\//, "").replace(/\/$/, "")}</span>
        </a>
      )}
      {mine && (
        <button type="button" onClick={() => setEditing(true)} className="h-8 px-3 rounded-full text-[0.8125rem] font-semibold text-emerald hover:underline">
          {has ? "Edit links" : "+ Add X, Telegram, website"}
        </button>
      )}
      {editing && <LinksEditor coinId={coinId} links={links} onClose={() => setEditing(false)} />}
    </div>
  );
}

function LinksEditor({ coinId, links, onClose }: { coinId: string; links: CoinLinks; onClose: () => void }) {
  const { signMessage } = useWallet();
  const [draft, setDraft] = useState<LinkDraft>(linksToDraft(links));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(linksToDraft(links)), [links]);
  const bad = draftProblems(draft);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveLinks(signMessage, coinId, draftToLinks(draft));
      toast("Links saved");
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Your coin's links" onClose={onClose}>
      <p className="text-[0.875rem] text-ink-2 mb-3">Show buyers where your community lives. All optional; leave a box empty to remove it.</p>
      <div className="grid gap-2">
        <LinkFields value={draft} onChange={setDraft} />
      </div>
      {error && (
        <p role="alert" className="text-danger text-[0.8125rem] mt-3">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy || bad.x || bad.telegram || bad.website}
        onClick={() => void save()}
        className="mt-4 w-full h-12 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save links"}
      </button>
    </Sheet>
  );
}

export function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.32l4.37 5.78L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z" />
    </svg>
  );
}
export function TgIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.2l-4.7-1.5c-1-.3-1-1 .2-1.5L20.5 3c.9-.3 1.6.2 1.4 1.3Z" />
    </svg>
  );
}
export function WebIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  );
}
