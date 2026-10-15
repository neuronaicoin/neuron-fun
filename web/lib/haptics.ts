/**
 * A very short, light tick under the finger when something is tapped (phones only).
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

/** One light tick. Call it from inside a tap (browsers ignore it otherwise). */
export function haptic() {
  if (busy || !enabled()) return;
  const now = Date.now();
  if (now - last < 50) return;
  last = now;
  busy = true;
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(8);
    else iosSwitch()?.click();
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
    haptic();
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
