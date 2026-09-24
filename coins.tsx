"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Coin, Parent } from "@/lib/data";
import { fetchCoins, fetchParents, neuronBurned, isImageUrl } from "@/lib/data";
import { fmtEth } from "@/lib/format";

export function CoinAvatar({ logo, symbol, size = 48 }: { logo: string; symbol: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (logo && isImageUrl(logo) && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt="" style={style} className="rounded-2xl object-cover bg-mist shrink-0" onError={() => setBroken(true)} />;
  }
  const letter = (symbol || "?").slice(0, 1).toUpperCase();
  return (
    <span style={style} className="rounded-2xl bg-emerald-soft text-emerald-dark font-display font-semibold flex items-center justify-center shrink-0" aria-hidden="true">
      <span style={{ fontSize: size * 0.42 }}>{letter}</span>
    </span>
  );
}

export function CoinCard({ coin }: { coin: Coin }) {
  return (
    <Link
      href={`/coin/?a=${coin.token}`}
      className="block bg-white border border-line rounded-2xl p-4 sm:p-5 hover:border-emerald transition-colors"
    >
      <div className="flex items-center gap-3.5">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} />
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold text-[17px] truncate">{coin.name}</div>
          <div className="text-[13px] text-ink-2 truncate">
            ${coin.symbol} · family of <span className="font-semibold text-emerald">${coin.parentSymbol}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-mist">
        <Stat label="Market value" value={fmtEth(coin.marketCapWei, 3)} />
        <Stat label={`Spent burning $${coin.parentSymbol}`} value={fmtEth(coin.burnedForParentWei, 5)} />
      </div>
    </Link>
  );
}

export function Stat({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={"text-[12px] " + (dark ? "text-[#a9bab3]" : "text-ink-3")}>{label}</div>
      <div className="font-mono text-[15px] truncate">{value}</div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={"animate-pulse rounded-2xl bg-line/60 " + className} />;
}

export type SiteData = {
  coins: Coin[];
  parents: Parent[];
  neuronBurned: bigint;
};

export function useSiteData() {
  const [data, setData] = useState<SiteData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      const coins = await fetchCoins();
      const [parents, burned] = await Promise.all([fetchParents(coins), neuronBurned()]);
      setData({ coins, parents, neuronBurned: burned });
    } catch {
      setError("Could not reach the network. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  return { data, error, reload: load };
}
