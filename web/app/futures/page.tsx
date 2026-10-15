"use client";

/** Futures: leverage trading on Hyperliquid (?c=BTC picks the market). */
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PerpsScreen } from "@/components/perps";

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const q = useSearchParams();
  const c = (q.get("c") ?? "BTC").replace(/[^A-Za-z0-9:]/g, "").slice(0, 20);
  return <PerpsScreen initialCoin={c || "BTC"} />;
}
