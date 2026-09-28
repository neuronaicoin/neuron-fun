"use client";

import { useEffect, useRef, useState } from "react";

const COLORS = ["#ff6b1a", "#ffb020", "#2fd39b", "#3b6ff5", "#f472b6", "#fff4ec"];

/** A one-off burst of confetti over the page. Skipped when motion is reduced. */
export function Confetti({ onDone }: { onDone?: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 90 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      dur: 2.4 + Math.random() * 1.6,
      size: 6 + Math.random() * 7,
      color: COLORS[i % COLORS.length],
      drift: (Math.random() - 0.5) * 220,
      spin: (Math.random() - 0.5) * 1440,
      round: Math.random() > 0.6,
    }))
  );
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), 4400);
    return () => clearTimeout(t);
  }, [onDone]);
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return (
    <div className="fixed inset-0 z-[70] pointer-events-none overflow-hidden" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.round ? p.size : p.size * 0.45,
              background: p.color,
              borderRadius: p.round ? "50%" : 2,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
              "--drift": `${p.drift}px`,
              "--spin": `${p.spin}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Celebrates a graduation: once per coin on this device when you first see
 * it graduated, and again live if it graduates while you're watching.
 */
export function useGraduationParty(coinId: string, graduated: boolean): boolean {
  const [party, setParty] = useState(false);
  const was = useRef<boolean | null>(null);
  useEffect(() => {
    if (!coinId) return;
    const key = `sasa-grad-seen:${coinId}`;
    if (graduated) {
      let seen = false;
      try {
        seen = localStorage.getItem(key) === "1";
        localStorage.setItem(key, "1");
      } catch {}
      if (!seen || was.current === false) setParty(true);
    }
    was.current = graduated;
  }, [coinId, graduated]);
  return party;
}
