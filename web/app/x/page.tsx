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
  const fromPath =
    typeof window !== "undefined" ? /^\/x\/([a-z]+)\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/?$/.exec(window.location.pathname) : null;
  const network = fromPath?.[1] ?? q.get("n") ?? "";
  const rawAddress = fromPath?.[2] ?? q.get("a") ?? "";
  // Solana addresses are case-sensitive; EVM ones are kept lowercase
  const address = isSolExt(network) ? rawAddress.trim() : rawAddress.toLowerCase();
  const valid = !!extNetwork(network) && extAddressOk(network, address);
  const [coin, setCoin] = useState<ExtCoin | null | undefined>(undefined);
  const [goingLive, setGoingLive] = useState(false);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let c: ExtCoin | null = null;
      try {
        c = await fetchExtCoin(network, address);
      } catch {
        if (alive) setCoin((x) => x ?? null);
      }
      if (!alive) return;
      // a Solana coin launched on sasa a moment ago: the keeper lists it within seconds
      let soon = false;
      if (!c && isSolExt(network)) {
        const st = await fetch(`/api/sol/coin/${address}`)
          .then((r) => r.json() as Promise<{ status?: string | null }>)
          .catch(() => ({ status: null }));
        soon = st.status === "pending";
      }
      if (!alive) return;
      setGoingLive(soon);
      if (c || !soon) setCoin((x) => c ?? (x === undefined ? null : x));
      // fast while it's new (going live, or its market numbers not in yet), then every minute
      const fast = soon || (c !== null && (!c.pool || c.mcapUsd === null));
      timer = setTimeout(function next() {
        // hidden tab: wait for it to be seen again (no calls while nobody looks)
        if (document.visibilityState === "visible") void load();
        else timer = setTimeout(next, 5_000);
      }, fast ? 5_000 : 60_000);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [network, address, valid]);
  if (goingLive && !coin)
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center flex flex-col gap-4 items-center" role="status" aria-live="polite">
        <span className="relative flex w-16 h-16" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-[#9945ff]/25 animate-ping" />
          <span className="relative w-16 h-16 rounded-full flex items-center justify-center text-[1.75rem] bg-[#9945ff]">🚀</span>
        </span>
        <h1 className="text-[1.5rem] font-bold">This coin is going live…</h1>
        <p className="text-ink-2 max-w-sm">It&apos;s on Solana. Its page opens here by itself in a few seconds.</p>
      </div>
    );

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

