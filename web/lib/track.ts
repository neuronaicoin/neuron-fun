/**
 * Google Analytics events for the things that matter (Analytics → Admin → Events → mark them as
 * key events): sign_up (an address seen for the first time on this device), login, launch_coin,
 * buy, sell. Never sends amounts tied to a person, addresses or anything private: only what kind
 * of action, and on which part of the site.
 */
type Gtag = (cmd: "event", name: string, params?: Record<string, string | number>) => void;

export function track(name: "sign_up" | "login" | "launch_coin" | "buy" | "sell", params: Record<string, string | number> = {}) {
  try {
    const g = (window as unknown as { gtag?: Gtag }).gtag;
    g?.("event", name, { page: window.location.pathname, ...params });
  } catch {
    // analytics must never break the site
  }
}

/** A success message → its event (toasts are where every buy, sale and launch ends up). */
export function trackFromMessage(text: string, kind?: string) {
  if (kind === "buy" || /^(Bought|Buying)\b/.test(text)) track("buy");
  else if (kind === "sell" || /^Sold\b/.test(text)) track("sell");
  // "…links didn't save" follows a launch already counted
  else if (/\bcoin is live\b|\bis live on\b/i.test(text) && !/didn't save/.test(text)) track("launch_coin");
}

/** Once per address per visit: login, and sign_up the first time this device sees it. */
export function trackAccount(address: string, method: "email" | "wallet") {
  try {
    const a = address.toLowerCase();
    if (sessionStorage.getItem(`trk:${a}`)) return;
    sessionStorage.setItem(`trk:${a}`, "1");
    if (!localStorage.getItem(`trk:${a}`)) {
      localStorage.setItem(`trk:${a}`, "1");
      track("sign_up", { method });
    } else track("login", { method });
  } catch {
    // private mode: no storage, no event
  }
}
