// Shared by the site and the API: turns whatever people paste into a clean
// X handle, Telegram name and https website (or null when empty/invalid).

/** "@name", "name", "x.com/name", "https://twitter.com/name?s=1" -> "name" */
export function cleanX(v) {
  let s = String(v ?? "").trim();
  if (!s) return { value: null, ok: true };
  s = s.replace(/^https?:\/\//i, "").replace(/^(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "");
  s = s.split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? { value: s, ok: true } : { value: null, ok: false };
}

/** "name", "@name", "t.me/name", "https://t.me/+InviteCode" -> "name" / "+InviteCode" */
export function cleanTelegram(v) {
  let s = String(v ?? "").trim();
  if (!s) return { value: null, ok: true };
  s = s.replace(/^https?:\/\//i, "").replace(/^(www\.)?(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  s = s.split(/[/?#]/)[0];
  if (/^[A-Za-z0-9_]{4,32}$/.test(s)) return { value: s, ok: true };
  if (/^\+[A-Za-z0-9_-]{8,40}$/.test(s)) return { value: s, ok: true }; // private-group invite
  return { value: null, ok: false };
}

/** Any normal web address -> "https://host/path" (http is upgraded; nothing else allowed). */
export function cleanWebsite(v) {
  let s = String(v ?? "").trim();
  if (!s) return { value: null, ok: true };
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { value: null, ok: false };
    if (u.username || u.password) return { value: null, ok: false };
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return { value: null, ok: false };
    const out = "https://" + u.hostname.toLowerCase() + (u.pathname === "/" ? "" : u.pathname) + u.search;
    return out.length <= 120 ? { value: out, ok: true } : { value: null, ok: false };
  } catch {
    return { value: null, ok: false };
  }
}

export const xUrl = (h) => `https://x.com/${h}`;
export const telegramUrl = (t) => `https://t.me/${t}`;
