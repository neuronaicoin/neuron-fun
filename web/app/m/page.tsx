"use client";

/** A coin from the Market list (the 300 biggest). */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ExtCoinView } from "@/components/extcoin";
import { fetchTopCoin, isTopId, topAsExt, type TopCoin } from "@/lib/topcoins";

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <TopCoinPage />
    </Suspense>
  );
}

function TopCoinPage() {
  const q = useSearchParams();
  // /m/<id>/ (search engines, shares) or /m/?id=<id> (in-app links)
  const fromPath = typeof window !== "undefined" ? /^\/m\/([a-z0-9-]+)\/?$/.exec(window.location.pathname) : null;
  const id = (fromPath?.[1] ?? q.get("id") ?? "").toLowerCase();
  const valid = isTopId(id);
  const [coin, setCoin] = useState<TopCoin | null | undefined>(undefined);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const load = () => fetchTopCoin(id).then((c) => alive && setCoin(c)).catch(() => alive && setCoin((x) => x ?? null));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, valid]);

  if (!valid || coin === null)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Coin not found</h1>
        <p className="text-ink-2 mt-2">It isn&apos;t in today&apos;s Market list of the 300 biggest coins.</p>
        <Link href="/market/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Back to Market</Link>
      </div>
    );
  if (coin === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  return <ExtCoinView coin={topAsExt(coin)} market={{ id: coin.id, rank: coin.rank, via: coin.via, change7d: coin.change7d }} />;
}
