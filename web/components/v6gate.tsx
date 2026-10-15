"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { V6 } from "@/lib/config";

/**
 * Pages that only work with v6 coins (testnet): on mainnet an old link to them moves on to
 * the page that does the same job for race coins, instead of showing an empty page.
 */
export function V6Gate({ to, children }: { to: string; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (!V6) router.replace(to);
  }, [router, to]);
  if (V6) return <>{children}</>;
  return <div className="max-w-xl mx-auto px-4 py-16 text-center text-ink-3 text-[0.9375rem]">Taking you there…</div>;
}
