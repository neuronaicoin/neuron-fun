/**
 * sasa's own anonymous visit log (POST /api/f → Supabase funnel_events), to find where visitors
 * stop: which pages they open, what they tap, which errors they see, when they leave.
 * A random id per visit (sessionStorage) and per device (localStorage); never typed text, amounts
 * or keys. Sent in small batches, and on leaving with sendBeacon. It must never break the site.
 */
type Ev = { ev: string; path: string; detail?: string; t: number };

const queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let started = 0;

function rid() {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("");
  } catch {
    return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }
}
function ids() {
  let sid = "", vid = "", fresh = false;
  try {
    sid = sessionStorage.getItem("sasa.f.sid") || "";
    if (!sid) {
      sid = rid();
      sessionStorage.setItem("sasa.f.sid", sid);
    }
    vid = localStorage.getItem("sasa.f.vid") || "";
    if (!vid) {
      vid = rid();
      fresh = true;
      localStorage.setItem("sasa.f.vid", vid);
    }
  } catch {
    sid = sid || "nostore" + rid();
  }
  return { sid, vid, fresh };
}
function who() {
  try {
    return localStorage.getItem("sasa-session-current") || "";
  } catch {
    return "";
  }
}

function send(beacon = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const { sid, vid } = ids();
  const body = JSON.stringify({ sid, vid, who: who(), events: queue.splice(0, 40) });
  try {
    if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/f", new Blob([body], { type: "application/json" }));
    else void fetch("/api/f", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
  } catch {}
  if (queue.length) send(beacon);
}

/** One step of the visit. */
export function funnel(ev: string, detail?: string) {
  try {
    if (typeof window === "undefined") return;
    if (/^\/admin/.test(location.pathname)) return;
    queue.push({ ev, path: location.pathname.slice(0, 120), detail: detail ? String(detail).replace(/\s+/g, " ").trim().slice(0, 200) : undefined, t: Date.now() });
    if (queue.length >= 25) send();
    else if (!timer) timer = setTimeout(() => send(), 8000);
  } catch {}
}

const seenErr = new Set<string>();
/** Starts the log once: the landing, taps on buttons and links, errors on screen, leaving. */
export function startFunnel() {
  if (started || typeof window === "undefined") return;
  started = Date.now();
  try {
    const { fresh } = ids();
    const u = new URL(location.href);
    const utm = ["utm_source", "utm_medium", "utm_campaign", "ref"].map((k) => (u.searchParams.get(k) ? `${k}=${u.searchParams.get(k)}` : "")).filter(Boolean).join("&");
    let ref = "";
    try {
      ref = document.referrer ? new URL(document.referrer).host : "";
    } catch {}
    const mobile = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "mobile" : "desktop";
    funnel("land", [fresh ? "new" : "return", mobile, ref && `from:${ref}`, utm].filter(Boolean).join(" · "));

    // taps: the label of the button or link (never what was typed)
    document.addEventListener(
      "click",
      (e) => {
        const el = (e.target as Element | null)?.closest?.("button, a, [role=button], [role=tab]") as HTMLElement | null;
        if (!el) return;
        const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const href = el.tagName === "A" ? (el.getAttribute("href") || "").slice(0, 80) : "";
        if (!label && !href) return;
        funnel(el.tagName === "A" ? "link" : "tap", [label, href && `→ ${href}`].filter(Boolean).join(" "));
      },
      { capture: true, passive: true }
    );

    // errors shown on screen (every red message on the site uses text-danger)
    let scan: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      scan = null;
      document.querySelectorAll(".text-danger, [role=alert]").forEach((n) => {
        // red trade rows, prices and % changes are not errors: only messages outside lists
        if ((n as HTMLElement).closest("li, tr, table, ul, ol, a, button")) return;
        const t = (n as HTMLElement).innerText?.replace(/\s+/g, " ").trim();
        if (!t || t.length < 12 || !/[a-z]{3,}.*\s.*[a-z]{2,}/i.test(t) || /^[−+\-]?[$\d.,%KMB ]+$/.test(t) || seenErr.has(t)) return;
        // short labels with a number (a red trade row, "Sell $120", or the same translated by the browser) are not errors
        if (/\d/.test(t) && t.split(" ").length <= 4) return;
        seenErr.add(t);
        funnel("error_shown", t);
      });
    };
    new MutationObserver(() => {
      if (!scan) scan = setTimeout(look, 600);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    // ResizeObserver loop notices are harmless browser noise and can fire hundreds of times a session
    window.addEventListener("error", (e) => {
      if (/ResizeObserver loop/i.test(e.message || "")) return;
      funnel("js_error", `${e.message || ""}`.slice(0, 180));
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = (e as PromiseRejectionEvent).reason;
      funnel("js_error", `promise: ${String((r && (r.message || r)) || "").slice(0, 170)}`);
    });

    let leftAt = 0;
    const leave = () => {
      if (Date.now() - leftAt < 2000) return;
      leftAt = Date.now();
      funnel("leave", `${Math.round((Date.now() - started) / 1000)}s`);
      send(true);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") leave();
    });
    window.addEventListener("pagehide", leave);
  } catch {}
}
