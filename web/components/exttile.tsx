"use client";

import Link from "next/link";
import { useState } from "react";
import { extHref, extNetwork, money, type ExtCoin } from "@/lib/extcoins";

// Stable colors for coins without a picture (from the address).
const GRADS = [
  ["#0f766e", "#134e4a"],
  ["#1d4ed8", "#1e1b4b"],
  ["#7c3aed", "#2e1065"],
  ["#b45309", "#431407"],
  ["#be185d", "#4a044e"],
  ["#15803d", "#052e16"],
];

/** A coin from any DEX, laid out like our own tiles (without the graduation bar). */
export function ExtTile({ coin }: { coin: ExtCoin }) {
  const net = extNetwork(coin.network);
  const [broken, setBroken] = useState(false);
  const ch = coin.change24h;
  const g = GRADS[parseInt(coin.address.slice(2, 4), 16) % GRADS.length];
  return (
    <Link
      href={extHref(coin)}
      className="group rounded-3xl border border-line bg-surface overflow-hidden flex flex-col hover:border-emerald/60 transition-colors min-w-0"
    >
      <div className="relative aspect-square m-2 mb-0 rounded-2xl overflow-hidden" style={{ background: `linear-gradient(145deg, ${g[0]}, ${g[1]})` }}>
        {coin.image && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coin.image} alt="" loading="lazy" onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center font-display font-bold text-white/90 text-[2.5rem] sm:text-[3.25rem]" aria-hidden="true">
            {coin.symbol.slice(0, 2).toUpperCase()}
          </span>
        )}
        {net && (
          <span className="absolute top-2 left-2 h-6 px-2 rounded-full text-[0.6875rem] font-bold text-white flex items-center shadow" style={{ background: net.color }}>
            {net.label}
          </span>
        )}
      </div>
      <div className="p-3 sm:p-4 pt-2.5 flex flex-col gap-2 flex-1 min-w-0">
        <div className="min-w-0">
          <div className="font-display font-semibold text-[1rem] truncate">{coin.name}</div>
          <div className="text-[0.75rem] text-ink-3 font-mono truncate">${coin.symbol}</div>
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[0.625rem] text-ink-3 uppercase tracking-wide">MC</div>
            <div className="font-mono font-semibold text-[1rem] truncate">{money(coin.mcapUsd)}</div>
          </div>
          {ch !== null && (
            <span className={"shrink-0 font-mono text-[0.75rem] font-semibold px-2 py-1 rounded-lg " + (ch >= 0 ? "bg-up/15 text-up" : "bg-danger/15 text-danger")}>
              {ch >= 0 ? "+" : ""}
              {ch.toFixed(1)}%
            </span>
          )}
        </div>
        <div className="mt-auto pt-2 border-t border-line text-[0.6875rem] text-ink-3 font-mono truncate">
          Vol {money(coin.vol24h)} · Liq {money(coin.liqUsd)}
        </div>
      </div>
    </Link>
  );
}
