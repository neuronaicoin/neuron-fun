"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { Sheet } from "./chrome";
import { toast } from "./alerts";
import { CoinAvatar } from "./coins";
import { useWallet } from "./wallet";
import { usdcAbi } from "@/lib/abis";
import { BOOST_ON, BOOST_PLANS, boostCalls, boostChains, fetchBoosted, leftText, useBoostedUntil } from "@/lib/boost";
import { clientFor, coinHref, fetchCoin, type Coin } from "@/lib/data";
import { compactUsd, friendlyError } from "@/lib/format";
import { openMoney, refreshPortfolio } from "@/lib/portfolio";

/** Explore: the coins someone paid to show here, above the (unchanged) ranking. */
export function BoostedRow() {
  const [coins, setCoins] = useState<{ coin: Coin; until: number }[]>([]);
  useEffect(() => {
    if (!BOOST_ON()) return;
    let alive = true;
    fetchBoosted()
      .then((rows) => Promise.all(rows.map(async (r) => ({ coin: ((await fetchCoin(r.coinId).catch(() => null))?.coin ?? null) as Coin | null, until: r.until }))))
      .then((list) => alive && setCoins(list.filter((x): x is { coin: Coin; until: number } => !!x.coin)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!coins.length) return null;
  return (
    <section aria-label="Promoted coins" className="mt-4">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="font-semibold text-[0.9375rem]">Promoted</h2>
        <span className="text-[0.75rem] text-ink-3">Paid placement</span>
      </div>
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        {coins.map(({ coin }) => (
          <Link
            key={coin.id}
            href={coinHref(coin)}
            className="shrink-0 w-[12.5rem] flex items-center gap-2.5 rounded-xl border border-line p-2.5 hover:border-ink-3"
          >
            <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={36} />
            <span className="min-w-0">
              <b className="block truncate font-semibold text-[0.9375rem]">{coin.name}</b>
              <span className="block font-mono text-[0.8125rem]">{compactUsd(coin.totalUsd)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Coin page: anyone can boost a coin; the time adds up. */
export function BoostButton({ coin }: { coin: Coin }) {
  const token = (coin.curves[0]?.token ?? null) as Address | null;
  const until = useBoostedUntil(token);
  const [open, setOpen] = useState(false);
  if (!BOOST_ON() || !token) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 px-3 rounded-xl border border-line font-semibold text-[0.8125rem] whitespace-nowrap hover:border-ink-3"
      >
        {until ? `Promoted · ${leftText(until)}` : "Promote"}
      </button>
      {open && <BoostSheet coin={coin} token={token} onClose={() => setOpen(false)} />}
    </>
  );
}

function BoostSheet({ coin, token, onClose }: { coin: Coin; token: Address; onClose: () => void }) {
  const { address, send } = useWallet();
  const [plan, setPlan] = useState(0);
  const [busy, setBusy] = useState(false);
  const price = BOOST_PLANS[plan].price;

  async function go() {
    if (!address) return toast("Log in first");
    try {
      setBusy(true);
      // Pay on a chain where there's enough cash.
      const need = BigInt(price) * 1_000_000n;
      let chain = null;
      for (const c of boostChains()) {
        const bal = (await clientFor(c).readContract({ address: c.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] }).catch(() => 0n)) as bigint;
        if (bal >= need) {
          chain = c;
          break;
        }
      }
      if (!chain) {
        toast(`You need $${price} in cash`);
        openMoney({ kind: "deposit" });
        return;
      }
      await send(chain.chain, boostCalls(chain, token, plan), () => {});
      toast(`$${coin.symbol} promoted for ${BOOST_PLANS[plan].hours} hours`);
      void refreshPortfolio(true);
      onClose();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Promote $${coin.symbol}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {BOOST_PLANS.map((p) => (
          <button
            key={p.plan}
            type="button"
            aria-pressed={plan === p.plan}
            onClick={() => setPlan(p.plan)}
            className={"rounded-xl border p-3 text-left " + (plan === p.plan ? "border-ink ring-1 ring-ink" : "border-line")}
          >
            <b className="block text-[1.125rem]">${p.price}</b>
            <span className="text-[0.75rem] text-ink-3">+{p.hours} hours</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[0.8125rem] text-ink-2">Shows ${coin.symbol} in the Promoted row on Explore. Adds to the time left; anyone can promote a coin they like.</p>
      <button type="button" disabled={busy} onClick={() => void go()} className="mt-3 w-full h-12 rounded-xl bg-emerald text-on-accent font-bold disabled:opacity-50">
        {busy ? "Promoting…" : `Promote for $${price}`}
      </button>
    </Sheet>
  );
}
