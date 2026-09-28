"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A sideways row (chips, tabs) that shows ‹ › arrows and soft edges when
 * there is more to see. Works with touch swipes, trackpads and the mouse
 * wheel. `edge` is the background the row sits on, for the fades.
 */
export function ScrollRow({
  children,
  edge = "surface",
  label,
  className = "",
}: {
  children: ReactNode;
  edge?: "surface" | "paper" | "mist";
  label?: string;
  className?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);

  const update = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setLeft(el.scrollLeft > 4);
    setRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    // A vertical mouse wheel scrolls the row sideways when it can.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && e.deltaY > 0;
      if (atStart || atEnd) return; // let the page scroll
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [update, children]);

  const by = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.7, behavior: "smooth" });
  const from = edge === "paper" ? "from-paper" : edge === "mist" ? "from-mist" : "from-surface";

  return (
    <div className={"relative min-w-0 " + className}>
      <div ref={row} onScroll={update} className="flex gap-2 overflow-x-auto no-scrollbar scroll-smooth p-0.5" role="group" aria-label={label}>
        {children}
      </div>
      {left && (
        <div className={"pointer-events-none absolute inset-y-0 left-0 w-12 flex items-center bg-gradient-to-r to-transparent " + from}>
          <ArrowBtn dir={-1} onClick={() => by(-1)} />
        </div>
      )}
      {right && (
        <div className={"pointer-events-none absolute inset-y-0 right-0 w-12 flex items-center justify-end bg-gradient-to-l to-transparent " + from}>
          <ArrowBtn dir={1} onClick={() => by(1)} />
        </div>
      )}
    </div>
  );
}

function ArrowBtn({ dir, onClick }: { dir: 1 | -1; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={onClick}
      className="pointer-events-auto hidden sm:flex w-8 h-8 rounded-full border border-line bg-surface text-ink shadow-[0_2px_10px_rgba(0,0,0,0.12)] items-center justify-center hover:border-emerald"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === 1 ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7"} />
      </svg>
    </button>
  );
}
