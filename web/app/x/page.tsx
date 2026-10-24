"use client";

/** A coin from any DEX (All coins). */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { extAddressOk, extNetwork, fetchExtCoin, isSolExt, type ExtCoin } from "@/lib/extcoins";
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
  // /x/<network>/<address> (search engines, shares) or /x/?n=<network>&a=<address> (in-app links)
  const fromPath = typeof window !== "undefined" ? /^\/x\/([a-z]+)\/(0x[0-9a-fA-F]{40})\/?$/.exec(window.location.pathname) : null;
  const network = fromPath?.[1] ?? q.get("n") ?? "";
  const rawAddress = fromPath?.[2] ?? q.get("a") ?? "";
  // Solana addresses are case-sensitive; EVM ones are kept lowercase
  const address = isSolExt(network) ? rawAddress.trim() : rawAddress.toLowerCase();
  const valid = !!extNetwork(network) && extAddressOk(network, address);
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
        <p className="text-ink-2 mt-2">We don&apos;t have this coin. We only list coins that really traded and passed the token check.</p>
        <Link href="/explore/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Back to coins</Link>
      </div>
    );
  if (coin === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  return <ExtCoinView coin={coin} />;
}

