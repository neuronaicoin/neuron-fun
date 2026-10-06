"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { clientFor } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { refreshPortfolio } from "@/lib/portfolio";
import { chainForNetwork, quoteCalls, quoteSwap } from "@/lib/extswap";
import type { Quote } from "@/lib/relay";

import { ContractAddress } from "./contract";
import Link from "next/link";
import { extNetwork, money, price, type ExtCoin } from "@/lib/extcoins";
import { IS_TESTNET } from "@/lib/config";
import { postOnX } from "@/components/share";
import { extHref } from "@/lib/extcoins";

const EXPLORER: Record<string, string> = {
  base: "https://basescan.org/token/",
  bsc: "https://bscscan.com/token/",
  eth: "https://etherscan.io/token/",
  robinhood: "https://explorer.chain.robinhood.com/token/",
  arc: "https://arcscan.app/token/",
};
const FEE = 0.007;

/** Price, stats, chart, token check and trade box of a coin from any DEX. */
export function ExtCoinView({ coin, backLink = true }: { coin: ExtCoin; backLink?: boolean }) {
  const net = extNetwork(coin.network)!;
  const [broken, setBroken] = useState(false);
  const [light, setLight] = useState(false);
  useEffect(() => {
    const read = () => setLight(document.documentElement.dataset.theme === "light");
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  const ch = coin.change24h;
  const kpis: [string, string, string?][] = [
    ["Price", price(coin.priceUsd)],
    ["Market cap", money(coin.mcapUsd)],
    ["24h", ch === null ? "—" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`, ch === null ? "" : ch >= 0 ? "text-up" : "text-danger"],
    ["Volume 24h", money(coin.vol24h)],
    ["Liquidity", money(coin.liqUsd)],
  ];
  return (
    <div className={backLink ? "max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12" : ""}>
      {backLink && <Link href="/explore/" className="text-emerald font-semibold text-[0.875rem]">← All coins</Link>}
      <div className={(backLink ? "mt-3 " : "") + "grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] items-start"}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
          <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex items-center gap-3 min-w-0">
              {coin.image && !broken ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coin.image} alt="" width={56} height={56} onError={() => setBroken(true)} className="w-14 h-14 rounded-2xl object-cover bg-paper shrink-0" />
              ) : (
                <span className="w-14 h-14 rounded-2xl bg-paper flex items-center justify-center font-display font-bold text-ink-2 shrink-0" aria-hidden="true">
                  {coin.symbol.slice(0, 2).toUpperCase()}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="font-display font-bold text-[1.375rem] sm:text-[1.75rem] leading-tight truncate">{coin.name}</h1>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <span className="font-mono text-[0.8125rem] text-ink-3">${coin.symbol}</span>
                  <span className="h-6 px-2 rounded-full text-[0.6875rem] font-bold text-white flex items-center" style={{ background: net.color }}>{net.label}</span>
                  <button
                    type="button"
                    onClick={() =>
                      postOnX(
                        IS_TESTNET
                          ? `$${coin.symbol} is listed on sasa 👀\n\nSoon: buy it in USDC in one tap, no bridging, no gas.${coin.xHandle ? `\n\n@${coin.xHandle}` : ""}`
                          : `$${coin.symbol} is trading on sasa 🔥\n\nBuy it in USDC in one tap: no bridging, no gas.${coin.xHandle ? `\n\n@${coin.xHandle}` : ""}`,
                        `https://sasapad.fun${extHref(coin)}`
                      )
                    }
                    className="h-7 px-2.5 rounded-lg border border-line text-[0.75rem] font-semibold hover:border-emerald/60 flex items-center gap-1"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Z" /></svg>
                    Share
                  </button>
                  {EXPLORER[coin.network] && (
                    <a href={EXPLORER[coin.network] + coin.address} target="_blank" rel="noopener noreferrer" className="text-[0.75rem] text-emerald font-semibold">Explorer ↗</a>
                  )}
                </div>
                <ContractAddress
                  className="mt-2"
                  entries={[{ key: coin.network, label: net.label, color: net.color, address: coin.address, explorer: EXPLORER[coin.network] ? EXPLORER[coin.network] + coin.address : null }]}
                />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
              {kpis.map(([k, v, cls]) => (
                <div key={k} className="rounded-xl sm:rounded-2xl border border-line bg-paper px-2.5 py-1.5 sm:p-3 min-w-0 flex items-baseline justify-between gap-1.5 sm:block">
                  <div className="text-[0.6875rem] text-ink-3 shrink-0">{k}</div>
                  <div className={"font-mono font-semibold text-[0.875rem] sm:text-[0.9375rem] truncate text-right sm:text-left " + (cls ?? "")}>{v}</div>
                </div>
              ))}
            </div>
          </section>

          {coin.pool && (
            <section className="rounded-3xl border border-line bg-surface overflow-hidden">
              <iframe
                key={light ? "l" : "d"}
                title={`${coin.symbol} chart`}
                src={`https://www.geckoterminal.com/${coin.network}/pools/${coin.pool}?embed=1&info=0&swaps=0&light_chart=${light ? 1 : 0}`}
                className="w-full h-[380px] sm:h-[460px] border-0 block"
                loading="lazy"
                allow="clipboard-write"
              />
            </section>
          )}

          <TokenCheck coin={coin} />
        </div>
        <TradeBox coin={coin} />
      </div>
    </div>
  );
}

function TokenCheck({ coin }: { coin: ExtCoin }) {
  const [open, setOpen] = useState(false);
  const checked = !!coin.checkedAt;
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(v * 100 < 1 && v > 0 ? 1 : 0)}%`);
  const rows: { ok: boolean | null; text: string }[] = checked
    ? [
        { ok: true, text: "Can be sold (checked by a sale simulation)" },
        { ok: (coin.buyTax ?? 0) <= 0.05 && (coin.sellTax ?? 0) <= 0.05, text: `Buy / sell tax: ${pct(coin.buyTax)} / ${pct(coin.sellTax)}` },
        { ok: coin.mintable === null ? null : !coin.mintable, text: coin.mintable ? "The owner can create new coins" : coin.mintable === false ? "The owner can't create new coins" : "Minting: unknown" },
        ...(coin.top10 !== null ? [{ ok: coin.top10 < 0.5, text: `Top 10 wallets hold ${pct(coin.top10)} of the supply` }] : []),
        { ok: (coin.liqUsd ?? 0) >= 50_000, text: `Liquidity: ${money(coin.liqUsd)} in the pool` },
      ]
    : [{ ok: null, text: "Our automatic check doesn't cover this chain yet. Coins that can't be sold are still hidden when we know about them." }];
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 text-left">
        <span className="font-display font-bold text-[1.125rem] flex items-center gap-2">
          Token check
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className={"text-ink-3 transition-transform " + (open ? "rotate-180" : "")}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
        <span className={"text-[0.75rem] font-semibold px-2.5 py-1 rounded-full " + (checked ? "bg-up/15 text-up" : "bg-paper text-ink-3")}>
          {checked ? "Sells normally" : "Not checked yet"}
        </span>
      </button>
      {open && (
        <ul className="mt-3 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.text} className="flex gap-3 py-2.5 text-[0.875rem]">
              <span className={"font-bold shrink-0 w-4 text-center " + (r.ok === null ? "text-ink-3" : r.ok ? "text-up" : "text-warn-ink")} aria-hidden="true">
                {r.ok === null ? "•" : r.ok ? "✓" : "!"}
              </span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.6875rem] text-ink-3 mt-3">Automatic checks. Memecoins are risky; only use money you can afford to lose.</p>
    </section>
  );
}

function TradeBox({ coin }: { coin: ExtCoin }) {
  const { address, send } = useWallet();
  const chain = chainForNetwork(coin.network);
  const live = !IS_TESTNET && !!chain;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [usd, setUsd] = useState("25");
  const [pct, setPct] = useState(100);
  const [held, setHeld] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const amount = Number(usd.replace(",", ".")) || 0;
  const estimate = coin.priceUsd ? (amount * (1 - FEE)) / coin.priceUsd : null;
  const fmt = (t: number) => (t >= 1e9 ? `${(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `${(t / 1e6).toFixed(2)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(1)}K` : t.toFixed(2));

  const loadHeld = useCallback(async () => {
    if (!live || !address || !chain) return setHeld(null);
    const b = (await clientFor(chain)
      .readContract({ address: coin.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      .catch(() => 0n)) as bigint;
    setHeld(b);
  }, [live, address, chain, coin.address]);
  useEffect(() => {
    void loadHeld();
  }, [loadHeld]);

  const raw = side === "buy" ? BigInt(Math.floor(amount * 1e6)) : held !== null ? (held * BigInt(pct)) / 100n : 0n;
  useEffect(() => {
    setQuote(null);
    setError("");
    if (!live || !address || !chain || raw <= 0n) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      quoteSwap({ chain, account: address, side, token: coin.address as Address, amount: raw, signal: ctrl.signal })
        .then(setQuote)
        .catch((e) => !ctrl.signal.aborted && setError(friendlyError(e)));
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, address, side, raw.toString(), coin.address]);

  async function go() {
    if (!quote || !chain) return;
    try {
      setBusy(side === "buy" ? "Buying…" : "Selling…");
      await send(chain.chain, quoteCalls(quote, chain), () => {});
      toast(side === "buy" ? `Bought $${coin.symbol} ✓` : `Sold $${coin.symbol} ✓`);
      void refreshPortfolio(true);
      setTimeout(() => void loadHeld(), 1500);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <aside className="rounded-3xl border border-line bg-surface p-4 sm:p-5 lg:sticky lg:top-24">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-paper" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={"h-11 rounded-xl font-bold " + (side === s ? (s === "buy" ? "bg-up text-on-accent" : "bg-danger text-white") : "text-ink-2")}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      {side === "buy" ? (
        <>
          <label className="mt-4 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
            <span className="text-ink-3 text-[1.375rem] mr-1">$</span>
            <input value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" aria-label="Amount in USDC" className="flex-1 min-w-0 bg-transparent outline-none text-[1.25rem]" />
          </label>
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {[10, 25, 50, 100].map((v) => (
              <button key={v} type="button" aria-pressed={amount === v} onClick={() => setUsd(String(v))} className={"h-10 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (amount === v ? "border-emerald text-emerald" : "border-line")}>
                ${v}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 mt-4">
          {[25, 50, 75, 100].map((v) => (
            <button key={v} type="button" aria-pressed={pct === v} onClick={() => setPct(v)} className={"h-10 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (pct === v ? "border-danger text-danger" : "border-line")}>
              {v === 100 ? "All" : `${v}%`}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-between rounded-2xl bg-paper px-4 py-3 text-[0.875rem]">
        <span className="text-ink-3">{side === "buy" ? "You get about" : "You get"}</span>
        <b className="font-mono">
          {quote
            ? side === "buy"
              ? `${quote.outAmount ? fmt(Number(quote.outAmount)) : "—"} $${coin.symbol}`
              : `$${Number(quote.outAmount).toFixed(2)}`
            : side === "buy"
              ? estimate !== null
                ? `${fmt(estimate)} $${coin.symbol}`
                : "—"
              : "—"}
        </b>
      </div>
      {live && side === "sell" && held !== null && (
        <p className="text-[0.75rem] text-ink-3 mt-2">You hold {held > 0n ? "some" : "no"} ${coin.symbol}</p>
      )}
      <button
        type="button"
        disabled={!live || !address || !quote || !!busy || (side === "sell" && (held ?? 0n) === 0n)}
        onClick={() => void go()}
        className={"mt-3 w-full h-13 rounded-2xl font-bold text-[1rem] disabled:opacity-50 " + (side === "buy" ? "bg-up text-on-accent" : "bg-danger text-white")}
      >
        {busy || (side === "buy" ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`)}
      </button>
      {error && <p className="mt-2 text-[0.8125rem] text-danger">{error}</p>}
      {IS_TESTNET && (
        <p className="mt-3 rounded-xl bg-emerald-soft border border-emerald/40 p-3 text-[0.8125rem]">Test version: prices and charts are live; trading these coins opens at mainnet.</p>
      )}
      {!IS_TESTNET && !chain && <p className="mt-3 text-[0.8125rem] text-ink-3">Trading coins on this chain is coming soon.</p>}
      <p className="text-[0.6875rem] text-ink-3 mt-2">0.7% fee. Best price across DEXs, paid in USDC.</p>
    </aside>
  );
}
