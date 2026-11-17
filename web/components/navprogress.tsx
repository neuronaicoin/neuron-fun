"use client";

/**
 * A thin orange bar at the top the moment someone taps a link inside the site, until the new page
 * is on screen. On a slow phone connection the next page can take a few seconds; without this the
 * tap looks dead and people tap again and again, then leave.
 */
import { useEffect, useRef, useState } from "react";

export function NavProgress() {
  const [on, setOn] = useState(false);
  const from = useRef("");
  useEffect(() => {
    let watch: ReturnType<typeof setInterval> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      setOn(false);
      if (watch) clearInterval(watch);
      if (giveUp) clearTimeout(giveUp);
      watch = undefined;
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(a.href, location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page / #hash
      from.current = location.pathname + location.search;
      setOn(true);
      if (watch) clearInterval(watch);
      if (giveUp) clearTimeout(giveUp);
      watch = setInterval(() => {
        if (location.pathname + location.search !== from.current) stop();
      }, 120);
      giveUp = setTimeout(stop, 12000);
    };
    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener("pageshow", stop);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("pageshow", stop);
      stop();
    };
  }, []);
  if (!on) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-[100] h-[3px] overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="h-full w-1/3 bg-[#ff6b1a] animate-[navbar_1.1s_ease-in-out_infinite]" />
      <style>{`@keyframes navbar{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}
