/**
 * A short tick under the finger when something is tapped (phones only); firmer when it opens
 * another page or a coin.
 * Android: the vibration API. iPhone (iOS 18+): Safari has no vibration API, but toggling a
 * hidden `<input type="checkbox" switch>` gives the system's own light tick, so a tap clicks one.
 * Off on computers, with "reduce motion", and when the user turns it off (localStorage
 * "sasa-haptics" = "off").
 */

let iosLabel: HTMLLabelElement | null = null;
let busy = false;
let last = 0;

function enabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (localStorage.getItem("sasa-haptics") === "off") return false;
  } catch {}
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  return !!window.matchMedia?.("(pointer: coarse)").matches;
}

function iosSwitch(): HTMLLabelElement | null {
  if (iosLabel) return iosLabel;
  if (typeof document === "undefined" || !document.body) return null;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.dataset.haptic = "1";
  label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  iosLabel = label;
  return label;
}

/**
 * How firm the tick is. Android: how long the phone buzzes. iPhone: the system tick has one
 * strength, so "strong" is two ticks right after each other (feels firmer).
 *   soft    sliding a finger along a chart (one per candle)
 *   normal  buttons, tabs, switches
 *   strong  going to another page or opening a coin
 */
export type HapticKind = "soft" | "normal" | "strong";
const BUZZ: Record<HapticKind, number> = { soft: 6, normal: 15, strong: 26 };

function tickIos() {
  try {
    iosSwitch()?.click();
  } catch {}
}

/** One tick. Call it from inside a tap or a touch (browsers ignore it otherwise). */
export function haptic(kind: HapticKind = "normal") {
  if (busy || !enabled()) return;
  const now = Date.now();
  if (now - last < (kind === "soft" ? 30 : 50)) return;
  last = now;
  busy = true;
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(BUZZ[kind]);
    else {
      tickIos();
      if (kind === "strong") setTimeout(tickIos, 45);
    }
  } catch {
  } finally {
    busy = false;
  }
}

/** What counts as a tap target: buttons, tabs, links (coins, menus), switches. */
const TAPPABLE = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="menuitem"], summary, input[type="checkbox"], input[type="radio"], input[type="range"], select';

/** Ticks on every tap on the page (installed once by the app shell). Returns the uninstaller. */
export function installHaptics(): () => void {
  if (typeof document === "undefined") return () => {};
  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || !(t instanceof Element) || t.closest("[data-haptic]")) return;
    const el = t.closest(TAPPABLE) as HTMLElement | null;
    if (!el || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" || el.closest("[data-no-haptic]")) return;
    // a link to another page (a coin, a menu item) gets the firmer tick; a link to a spot on
    // the same page or a new tab is an ordinary button
    const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") ?? "" : "";
    const opensPage = !!href && !href.startsWith("#") && el.getAttribute("target") !== "_blank";
    haptic(opensPage || el.hasAttribute("data-haptic-strong") ? "strong" : "normal");
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
