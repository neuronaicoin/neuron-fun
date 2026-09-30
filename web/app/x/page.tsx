"use client";

/** A coin from any DEX (All coins). */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { extNetwork, fetchExtCoin, type ExtCoin } from "@/lib/extcoins";
import { ExtCoinView } from "@/components/extcoin";

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <ExtCoinPage />
    </Suspense>
  );
}

function ExtCoinPage() {
  const q = useSearchParams();
  const network = q.get("n") ?? "";
  const address = (q.get("a") ?? "").toLowerCase();
  const valid = !!extNetwork(network) && /^0x[0-9a-f]{40}$/.test(address);
  const [coin, setCoin] = useState<ExtCoin | null | undefined>(undefined);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const load = () => fetchExtCoin(network, address).then((c) => alive && setCoin(c)).catch(() => alive && setCoin((x) => x ?? null));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [network, address, valid]);

  if (!valid || coin === null)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Coin not found</h1>
        <p className="text-ink-2 mt-2">It may have gone quiet: we only show coins that are actively traded.</p>
        <Link href="/explore/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Back to coins</Link>
      </div>
    );
  if (coin === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  return <ExtCoinView coin={coin} />;
}

