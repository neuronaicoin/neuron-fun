"use client";

/**
 * Whale card: a big trade anywhere on sasa pops up under the header for a few seconds,
 * tap → that coin. One shared list for every visitor (Supabase view whale_feed,
 * indexer/whalefeed.sql): other DEXs' coins from $5,000, sasa coins from $1,000.
 * Each trade shows once per visitor (remembered for the session); a backlog is never replayed,
 * only trades from the last 15 minutes.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { db } from "@/lib/data";
import { extHref, extNetwork } from "@/lib/extcoins";
import { RACE_CHAINS, raceHref } from "@/lib/race";

type W = { kind: "ext" | "sasa"; net: string; coin: string; tx: string; t: number; buy: boolean; usd: number; symbol: string | null; name: string | null; image: string | null };

const SHOW_MS = 4_000;
/** At most one card this often: a calm screen, not a stream of pop-ups. */
const GAP_MS = 45_000;
const SEEN_KEY = "sasa-whales-seen";

const amt = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`);

function chainLabel(w: W): string {
  if (w.kind === "sasa") return RACE_CHAINS.find((c) => c.chainId === Number(w.net))?.short ?? "sasa";
  return extNetwork(w.net)?.label ?? w.net;
}

export function WhaleCard() {
  const path = usePathname() ?? "";
  const [shown, setShown] = useState<W | null>(null);
  const queue = useRef<W[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const openedAt = useRef(Date.now() - 15 * 60_000);
  const lastAt = useRef(0);

  useEffect(() => {
    try {
      seen.current = new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || "[]"));
    } catch {}
    let alive = true;
    const load = async () => {
      const { data } = await db.from("whale_feed").select("kind,net,coin,tx,t,is_buy,usd,symbol,name,image").order("t", { ascending: false }).limit(20);
      if (!alive || !data) return;
      const fresh = (data as Record<string, unknown>[])
        .map((r) => ({
          kind: r.kind === "sasa" ? "sasa" : "ext",
          net: String(r.net),
          coin: String(r.coin),
          tx: String(r.tx),
          t: Date.parse(String(r.t)),
          buy: !!r.is_buy,
          usd: Number(r.usd) || 0,
          symbol: (r.symbol as string) || null,
          name: (r.name as string) || null,
          image: (r.image as string) || null,
        }) as W)
        .filter((w) => w.symbol && w.t >= openedAt.current && !seen.current.has(w.tx))
        .sort((a, b) => a.t - b.t);
      for (const w of fresh) {
        seen.current.add(w.tx);
        if (!queue.current.some((q) => q.tx === w.tx)) queue.current.push(w);
      }
      // never pile up: only the latest few wait their turn
      queue.current = queue.current.slice(-3);
      try {
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-200)));
      } catch {}
    };
    void load().catch(() => {});
    const poll = setInterval(() => document.visibilityState === "visible" && void load().catch(() => {}), 10_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, []);

  // one card at a time, each for a few seconds
  useEffect(() => {
    if (shown) {
      const t = setTimeout(() => setShown(null), SHOW_MS);
      return () => clearTimeout(t);
    }
    const t = setInterval(() => {
      if (Date.now() - lastAt.current < GAP_MS) return;
      const next = queue.current.pop();
      // only the newest one shows; older ones are dropped
      queue.current = [];
      if (next) {
        lastAt.current = Date.now();
        setShown(next);
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [shown]);

  // not over the admin pages, the create form, chat, or a coin page someone is reading
  if (!shown || /^\/(admin|race\/launch|chat|x|r|coin|me|learn)(\/|$)/.test(path)) return null;
  const href = shown.kind === "sasa" ? raceHref(shown.coin) : extHref({ network: shown.net, address: shown.coin });
  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-[4.25rem] sm:top-[4.75rem] z-40 w-[min(26rem,calc(100vw-1.5rem))] pointer-events-none">
      <Link
        href={href}
        onClick={() => setShown(null)}
        className={
          "whale-pop pointer-events-auto flex items-center gap-3 rounded-2xl px-3 py-2.5 shadow-lg border text-white " +
          (shown.buy ? "border-[#12a36b]/60" : "border-[#e5484d]/60")
        }
        style={{ background: shown.buy ? "linear-gradient(100deg,#0b3d2b,#0f6b47)" : "linear-gradient(100deg,#3d0b12,#7a1a24)" }}
      >
        <span className="text-[1.375rem] leading-none shrink-0" aria-hidden="true">🐋</span>
        {shown.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown.image} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover bg-white/10 shrink-0" />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block font-extrabold text-[0.9375rem] leading-tight truncate">
            {shown.buy ? "WHALE BUY" : "WHALE SELL"} {amt(shown.usd)}
          </span>
          <span className="block text-[0.75rem] text-white/80 truncate">
            ${shown.symbol} · {chainLabel(shown)}
          </span>
        </span>
        <span className="text-[0.75rem] font-bold shrink-0 bg-white/15 rounded-lg px-2 py-1">See →</span>
      </Link>
    </div>
  );
}
