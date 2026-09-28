"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { friendlyError } from "@/lib/format";
import { useAlerts, type Note } from "@/lib/alerts";
import {
  COLORS,
  EMOJIS,
  displayName,
  fetchProfile,
  loadFollowing,
  profileHref,
  saveAvatar,
  saveProfile,
  setFollowing,
  useFollowing,
  type Profile,
} from "@/lib/social";

/** The sasa mark, used as everyone's default avatar (on their own color). */
function SasaMark({ size }: { size: number }) {
  return (
    <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M22 58 L50 32 L78 58" fill="none" stroke="#fff" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 82 L50 56 L78 82" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="14" r="7" fill="#fff" />
    </svg>
  );
}

export function Avatar({ profile, size = 40, ring = false }: { profile: Pick<Profile, "color" | "emoji"> & { avatar?: string | null }; size?: number; ring?: boolean }) {
  if (profile.avatar)
    return (
      <img
        src={profile.avatar}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="rounded-full object-cover shrink-0 bg-line"
        style={{ width: size, height: size, boxShadow: ring ? "0 0 0 2px var(--color-emerald)" : undefined }}
      />
    );
  return (
    <span
      className="rounded-full inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size, background: profile.color, fontSize: Math.round(size * 0.52), boxShadow: ring ? "0 0 0 2px var(--color-emerald)" : undefined }}
      aria-hidden="true"
    >
      {profile.emoji || <SasaMark size={size} />}
    </span>
  );
}

/** Keeps "who I follow" in step with the logged-in wallet. Mounted once, in the header. */
export function SocialSync() {
  const { address } = useWallet();
  useEffect(() => {
    void loadFollowing(address ?? null);
  }, [address]);
  return <FollowPopup />;
}

export function FollowButton({ profile, big = false }: { profile: Pick<Profile, "address" | "username">; big?: boolean }) {
  const { address, signMessage } = useWallet();
  const { set } = useFollowing();
  const [busy, setBusy] = useState(false);
  const target = profile.address.toLowerCase();
  if (address && address.toLowerCase() === target) return null;
  const on = set.has(target);
  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={on}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!address) {
          toast("Log in to follow traders");
          return;
        }
        setBusy(true);
        try {
          await setFollowing(signMessage, target, !on);
          toast(on ? `Unfollowed ${displayName(profile)}` : `Following ${displayName(profile)}. You'll get a 🔔 when they buy.`);
        } catch (err) {
          toast(friendlyError(err));
        } finally {
          setBusy(false);
        }
      }}
      className={
        (big ? "h-11 px-6 text-[0.9375rem] " : "h-9 px-4 text-[0.8125rem] ") +
        "rounded-xl font-bold shrink-0 disabled:opacity-60 " +
        (on ? "border border-line text-ink" : "bg-emerald text-on-accent hover:bg-emerald-dark")
      }
    >
      {on ? "Following" : "Follow"}
    </button>
  );
}

export function EditProfileSheet({ current, onClose, onSaved }: { current: Profile; onClose: () => void; onSaved: () => void }) {
  const { signMessage, embedded } = useWallet();
  const [username, setUsername] = useState(current.username ?? "");
  const [color, setColor] = useState(current.color);
  const [emoji, setEmoji] = useState(current.emoji);
  const [bio, setBio] = useState(current.bio);
  const [hide, setHide] = useState(current.hideTrades);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taken, setTaken] = useState(false);
  // New picture waiting to be uploaded on Save (data: URL), "" = remove, null = unchanged.
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const shownPhoto = photo === null ? current.avatar : photo || null;

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setError("");
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
      setError("Pick a photo (JPG, PNG or WebP).");
      return;
    }
    setPhotoBusy(true);
    try {
      setPhoto(await squareWebp(file, 256));
    } catch {
      setError("Couldn't read that photo. Try another one.");
    } finally {
      setPhotoBusy(false);
    }
  }

  const valid = username === "" || /^[a-z0-9_]{3,20}$/.test(username);
  useEffect(() => {
    setTaken(false);
    if (!valid || !username || username === current.username) return;
    const t = setTimeout(() => {
      fetchProfile(username).then((p) => setTaken(!!p && p.address !== current.address)).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [username, valid, current.username, current.address]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (photo !== null) await saveAvatar(signMessage, photo || null);
      await saveProfile(signMessage, { username, color, emoji, bio, hideTrades: hide });
      toast("Profile saved");
      onSaved();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Edit profile" onClose={onClose}>
      <div className="flex flex-col items-center gap-2">
        <Avatar profile={{ color, emoji, avatar: shownPhoto }} size={84} />
        <div className="flex gap-2">
          <label className={"h-9 px-4 rounded-xl border border-line text-[0.8125rem] font-semibold flex items-center cursor-pointer hover:border-emerald " + (photoBusy ? "opacity-60" : "")}>
            {photoBusy ? "Preparing…" : shownPhoto ? "Change photo" : "Upload photo"}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => void pickPhoto(e.target.files?.[0])} />
          </label>
          {shownPhoto && (
            <button type="button" onClick={() => setPhoto("")} className="h-9 px-3 rounded-xl text-[0.8125rem] text-ink-3 hover:text-danger">
              Remove
            </button>
          )}
        </div>
      </div>
      <label className="block mt-4">
        <span className="font-semibold text-[0.875rem]">Username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="e.g. otterdad"
          style={{ outline: "none" }}
          className="mt-1.5 w-full h-12 rounded-xl bg-paper border border-line px-3 focus:border-emerald"
        />
        <span className={"block text-[0.8125rem] mt-1 " + (!valid || taken ? "text-danger" : "text-ink-3")}>
          {taken ? "That name is taken. " : !valid ? "Use 3–20 letters, numbers or _. " : ""}
          Your link: sasapad.fun/u/{username || "name"}
        </span>
      </label>
      <span className="block font-semibold text-[0.875rem] mt-4">{shownPhoto ? "Or pick a color and icon" : "Avatar"}</span>
      <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label="Color">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={color === c}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
            className={"w-10 h-10 rounded-full border-[3px] " + (color === c ? "border-ink" : "border-transparent")}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label="Emoji">
        {EMOJIS.map((e) => (
          <button
            key={e || "logo"}
            type="button"
            aria-pressed={emoji === e}
            aria-label={e ? `Emoji ${e}` : "sasa logo"}
            onClick={() => setEmoji(e)}
            className={"w-10 h-10 rounded-full bg-paper border-[3px] text-[1.2rem] flex items-center justify-center " + (emoji === e ? "border-ink" : "border-transparent")}
          >
            {e || <Avatar profile={{ color, emoji: "" }} size={30} />}
          </button>
        ))}
      </div>
      <label className="block mt-4">
        <span className="font-semibold text-[0.875rem]">Bio</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, 140))}
          rows={2}
          placeholder="One line about you"
          style={{ outline: "none" }}
          className="mt-1.5 w-full rounded-xl bg-paper border border-line px-3 py-2.5 focus:border-emerald resize-none"
        />
      </label>
      <div className="flex items-center justify-between gap-4 mt-4">
        <div>
          <div className="font-semibold text-[0.9375rem]">Hide my trades</div>
          <div className="text-ink-3 text-[0.8125rem]">Followers won&apos;t see your trades or get alerts, and you leave the leaderboard.</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={hide}
          aria-label="Hide my trades"
          onClick={() => setHide(!hide)}
          className={"relative w-12 h-7 rounded-full shrink-0 " + (hide ? "bg-emerald" : "bg-line")}
        >
          <span className={"absolute top-1 left-1 w-5 h-5 rounded-full bg-white transition-transform " + (hide ? "translate-x-5" : "")} />
        </button>
      </div>
      {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
      <button
        type="button"
        disabled={busy || !valid || taken}
        onClick={() => void save()}
        className="mt-5 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold hover:bg-emerald-dark disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {!embedded && <p className="text-[0.75rem] text-ink-3 text-center mt-2">Your wallet signs once to prove it&apos;s you. Free.</p>}
    </Sheet>
  );
}

/** Crops the middle square of a photo and shrinks it to size x size WebP (JPEG if WebP isn't supported). */
async function squareWebp(file: File, size: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    let out = canvas.toDataURL("image/webp", 0.85);
    if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", 0.85);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** When someone you follow buys (and the site is open): a card with "Buy too". */
function FollowPopup() {
  const { notes, ring } = useAlerts();
  const [shown, setShown] = useState<Note | null>(null);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (!ring || !notes || !notes.length) return;
    const n = notes[0];
    if (n.kind !== "follow" || n.read || n.id <= seen) return;
    setSeen(n.id);
    setShown(n);
    const t = setTimeout(() => setShown(null), 9000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring]);
  if (!shown) return null;
  let href = "/";
  try {
    const u = new URL(shown.url, location.origin);
    href = u.pathname + u.search;
  } catch {}
  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 z-[60] w-[min(24rem,calc(100vw-1.5rem))] bg-surface border border-line rounded-2xl shadow-[0_14px_40px_rgba(0,0,0,0.45)] p-3 flex items-center gap-3"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 4.6rem)" }}
    >
      <span className="text-[1.5rem]" aria-hidden="true">👥</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[0.9rem] leading-snug">{shown.title}</div>
        <div className="text-ink-3 text-[0.8125rem] truncate">{shown.body}</div>
      </div>
      <Link href={href} onClick={() => setShown(null)} className="h-10 px-4 rounded-xl bg-up text-on-accent font-bold text-[0.875rem] flex items-center shrink-0">
        Buy too
      </Link>
      <button type="button" onClick={() => setShown(null)} aria-label="Dismiss" className="text-ink-3 text-[1.25rem] leading-none px-1">
        ×
      </button>
    </div>
  );
}

export function ProfileLink({ profile, size = 32, children }: { profile: Profile; size?: number; children?: React.ReactNode }) {
  return (
    // Profiles are served by the server (/u/…), so a plain link.
    <a href={profileHref(profile)} className="flex items-center gap-2.5 min-w-0">
      <Avatar profile={profile} size={size} />
      {children ?? <span className="font-semibold truncate">{displayName(profile)}</span>}
    </a>
  );
}
