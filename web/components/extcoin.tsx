"use client";

import { BotSafety } from "./botsafety";
import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { clientFor } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { refreshPortfolio, afterTrade } from "@/lib/portfolio";
import { chainForNetwork, quoteCalls, quoteSwap } from "@/lib/extswap";
import type { Quote } from "@/lib/relay";
import { crossExtBuy, crossExtSell, extRoute, gasTopup, quoteCrossBuy, quoteCrossSell, xClient, type ExtSenders } from "@/lib/extcross";
import { autoReady, chainForNetwork as autoForNetwork } from "@/lib/auto";
import { raceClient } from "@/lib/race";
import { reportExtTrade } from "@/lib/exttrades";
import { rememberExtBuy } from "@/lib/extheld";
import { AutoPanel } from "./autopanel";
import { SolanaTradeBox } from "./soltrade";
import { TradeDock } from "./tradedock";
import { isSolExt } from "@/lib/extcoins";
import { SOL_RPC } from "@/lib/solana";

import { ContractAddress } from "./contract";
import Link from "next/link";
import { extNetwork, money, price, type ExtCoin } from "@/lib/extcoins";
import { IS_TESTNET } from "@/lib/config";
import { postOnX } from "@/components/share";
import { extPageUrl } from "@/lib/extcoins";
import { topPageUrl } from "@/lib/topcoins";
import { PriceChart } from "@/components/racechart";
import { fetchExtCandles } from "@/lib/extchart";
import { ExtTradesList, useExtLiveTrades, useExtTrades } from "@/components/exttrades";
import { CoinSeoSlot } from "@/components/coinseo";

const EXPLORER: Record<string, string> = {
  base: "https://basescan.org/token/",
  bsc: "https://bscscan.com/token/",
  eth: "https://etherscan.io/token/",
  robinhood: "https://explorer.chain.robinhood.com/token/",
  arc: "https://arcscan.app/token/",
  solana: "https://solscan.io/token/",
};
const FEE = 0.01;

/** An exchange's name for people: Solana's launch curve and its pools by what they are, not by brand. */
function dexName(dex: string | null): string {
  if (!dex) return "";
  if (/^pump/i.test(dex)) return /swap|amm/i.test(dex) ? "a Solana pool" : "its Solana launch curve";
  return dex.replace(/[-_]/g, " ");
}

/**
 * The coin's pool on Meteora's launch curve under sasa's own-fee config, when it has one (null
 * otherwise): the pool's address is fixed by the config and the coin, and it's there on chain.
 */
async function dbcPoolFor(PublicKey: typeof import("@solana/web3.js").PublicKey, mint: import("@solana/web3.js").PublicKey): Promise<string | null> {
  const cfg = (await (await fetch("/api/sol/config")).json().catch(() => ({}))) as { dbc?: string | null };
  if (!cfg.dbc) return null;
  const config = new PublicKey(cfg.dbc);
  const wsol = new PublicKey("So11111111111111111111111111111111111111112");
  // the two mints, larger first (byte order), as Meteora's program does
  const x = wsol.toBytes();
  const y = mint.toBytes();
  const i = x.findIndex((v, k) => v !== y[k]);
  const [a, b] = i >= 0 && x[i] > y[i] ? [wsol, mint] : [mint, wsol];
  const [pool] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("pool"), config.toBytes(), a.toBytes(), b.toBytes()],
    new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")
  );
  const address = pool.toBase58();
  const r = await fetch(SOL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
  });
  const j = (await r.json().catch(() => ({}))) as { result?: { value: unknown } };
  return j.result?.value ? address : null;
}

/** Price, stats, chart, token check and trade box of a coin from any DEX. */
/** A coin from the Market list: its page shows its rank, and what is bought for it (cbBTC for Bitcoin…). */
export type MarketInfo = { id: string; rank: number | null; via: string | null; change7d: number | null };

export function ExtCoinView({ coin, backLink = true, market }: { coin: ExtCoin; backLink?: boolean; market?: MarketInfo }) {
  const net = extNetwork(coin.network)!;
  const [broken, setBroken] = useState(false);
  // a Solana coin launched on sasa: its launch curve. Until the market lists have the coin it is
  // its pool, and its first trades are read straight from Solana (chart and list from the first second)
  const [curvePool, setCurvePool] = useState<string | null>(null);
  useEffect(() => {
    if (!coin.sasa || !isSolExt(coin.network)) return setCurvePool(null);
    let alive = true;
    import("@solana/web3.js")
      .then(async ({ PublicKey }) => {
        const mint = new PublicKey(coin.address);
        const [pda] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("bonding-curve"), mint.toBytes()],
          new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
        );
        // sasa's own-fee coins (Meteora's launch curve under sasa's config): their pool instead
        const dbc = await dbcPoolFor(PublicKey, mint).catch(() => null);
        if (alive) setCurvePool(dbc ?? pda.toBase58());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coin.sasa, coin.network, coin.address]);
  const pool = coin.pool ?? curvePool;
  // who bought and sold: the list under the chart, and the same trades on the chart
  const tradeRows = useExtTrades(pool === coin.pool ? coin : { ...coin, pool }, curvePool);
  const liveTrades = useExtLiveTrades(coin, tradeRows);
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
      {backLink && (
        <Link href={market ? "/market/" : "/explore/"} className="text-emerald font-semibold text-[0.875rem]">
          {market ? "← Market" : "← All coins"}
        </Link>
      )}
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
                  {(
                  <button
                    type="button"
                    onClick={() =>
                      postOnX(
                        IS_TESTNET
                          ? `$${coin.symbol} is listed on sasa 👀\n\nSoon: buy it in USDC in one tap, no bridging, no gas token.`
                          : isSolExt(coin.network)
                            ? `$${coin.symbol} on Solana 🔥${coin.mcapUsd ? ` ${money(coin.mcapUsd)} market cap` : ""}\n\nbuying it with plain USDC on sasa. no SOL, no wallet popups 👀`
                            : `$${coin.symbol} is trading on sasa 🔥\n\nBuy it in USDC in one tap: no bridging, no gas token.`,
                        market ? topPageUrl("https://sasapad.fun", market.id) : extPageUrl("https://sasapad.fun", coin),
                        { symbol: coin.symbol, chains: [net.label], handle: coin.xHandle }
                      )
                    }
                    className="h-7 px-2.5 rounded-lg border border-line text-[0.75rem] font-semibold hover:border-emerald/60 flex items-center gap-1"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Z" /></svg>
                    Share
                  </button>
                  )}
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
            {coin.quietSince && (
              <p className="mt-3 rounded-xl bg-paper border border-line px-3 py-2 text-[0.8125rem] text-ink-2">
                Not actively traded right now. These numbers are from {new Date(coin.quietSince).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}, the last time it was.
              </p>
            )}
          </section>

          {isSolExt(coin.network) && <BotSafety mint={coin.address} />}

          {pool && (
            <section className="sm:rounded-3xl sm:border sm:border-line sm:bg-surface sm:p-5 min-w-0">
              <PriceChart
                bleed
                cacheKey={`ext:${coin.network}:${pool}`}
                load={(frame) =>
                  fetchExtCandles(coin.network, pool, coin.address, frame)
                    .catch((e) => {
                      if (!curvePool) throw e;
                      return [];
                    })
                    .then(async (rows) => {
                      // a brand-new sasa coin: its first trades straight from Solana
                      if (rows.length || !curvePool) return rows;
                      const { fetchCurveCandles } = await import("@/lib/solcurvetrades");
                      return fetchCurveCandles(curvePool, coin.address, frame);
                    })
                }
                refreshMs={curvePool ? 10_000 : 30_000}
                mcFactor={coin.priceUsd && coin.mcapUsd ? coin.mcapUsd / coin.priceUsd : undefined}
                emptyText="No chart data for this coin yet."
                since={coin.poolCreated ? Date.parse(coin.poolCreated) || undefined : undefined}
                trades={liveTrades}
              />
            </section>
          )}

          {pool && <ExtTradesList coin={coin} rows={tradeRows} />}
          {!market && <TokenCheck coin={coin} />}
          {/* other DEXs' coins: the server's search section says all this and more (components/coinseo.tsx) */}
          {market ? <AboutCoin coin={coin} chain={net.label} market={market} /> : <CoinSeoSlot network={coin.network} address={coin.address} />}
        </div>
        {/* desktop: the trade box in the right column; phones: the Buy / Sell bar below */}
        <div className="hidden lg:block lg:sticky lg:top-20 self-start">{isSolExt(coin.network) ? <SolanaTradeBox coin={coin} /> : <TradeBox coin={coin} />}</div>
      </div>
      <TradeDock symbol={coin.symbol} render={(side) => (isSolExt(coin.network) ? <SolanaTradeBox coin={coin} initialSide={side} bare /> : <TradeBox coin={coin} initialSide={side} bare />)} />
    </div>
  );
}

/** Plain facts about the coin and how to buy it here (what someone searching for it wants to know). */
function AboutCoin({ coin, chain, market }: { coin: ExtCoin; chain: string; market?: MarketInfo }) {
  const sym = `$${coin.symbol}`;
  const created = coin.poolCreated ? new Date(coin.poolCreated).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  const facts = market
    ? [
        `${coin.name} (${coin.symbol})${market.rank ? ` is number ${market.rank} by market cap` : ""}${coin.mcapUsd ? `, worth about ${money(coin.mcapUsd)} in total` : ""}.`,
        coin.vol24h ? `About ${money(coin.vol24h)} of it traded in the last 24 hours across all markets.` : "",
        market.via
          ? `On sasa you buy it as ${market.via}: a token that follows its price one to one and trades on DEXs.`
          : `On sasa it is bought on ${chain}${dexName(coin.dex) ? `, mainly on ${dexName(coin.dex)}` : ""}${coin.liqUsd ? `, with ${money(coin.liqUsd)} of liquidity in the pool` : ""}.`,
      ].filter(Boolean)
    : [
    `${coin.name} (${sym}) is a coin on ${chain}${dexName(coin.dex) ? `, traded mainly on ${dexName(coin.dex)}` : ""}${created ? `. Its main pool opened on ${created}` : ""}.`,
    coin.mcapUsd ? `Its market cap is about ${money(coin.mcapUsd)}${coin.liqUsd ? ` with ${money(coin.liqUsd)} of liquidity in the pool` : ""}.` : "",
    coin.peakMcap && coin.mcapUsd && coin.peakMcap > coin.mcapUsd * 1.2 ? `The highest market cap we saw was ${money(coin.peakMcap)}.` : "",
    coin.sellTax !== null || coin.buyTax !== null
      ? `Token check: ${coin.buyTax ? `${(coin.buyTax * 100).toFixed(1)}% buy tax` : "no buy tax"}, ${coin.sellTax ? `${(coin.sellTax * 100).toFixed(1)}% sell tax` : "no sell tax"}${coin.mintable ? ", and the owner can still create more coins" : ""}${coin.top10 !== null ? `; the 10 biggest wallets hold ${(coin.top10 * 100).toFixed(0)}%` : ""}.`
      : "",
  ].filter(Boolean);
  const faq: [string, string][] = [
    [`How do I buy ${sym}?`, IS_TESTNET ? `Trading coins from other DEXs opens when sasa's mainnet starts. Then: log in with your email or a wallet, add USDC, and tap Buy on this page.` : `Log in on sasa with your email or a wallet, add USDC, and tap Buy on this page. sasa finds the best price across DEXs; you don't need ${chain === "Base" ? "ETH" : "that chain's gas coin"} or a bridge.`],
    ...(isSolExt(coin.network)
      ? []
      : ([[`Can I set a take profit or stop loss on ${sym}?`, `Yes. Use the Auto tab next to Buy and Sell: pick a price once and the order runs on its own, even with sasa closed. It costs 0.1% when it runs.`]] as [string, string][])),
    [`What is the ${sym} contract address?`, `${coin.address} on ${chain}. Always check the address before you buy: other coins can use the same name.`],
  ];
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label={`About ${coin.name}`}>
      <h2 className="font-display font-bold text-[1.0625rem]">About {coin.name}</h2>
      {facts.map((f) => (
        <p key={f} className="mt-2 text-[0.875rem] text-ink-2 break-words">{f}</p>
      ))}
      <div className="mt-3 flex flex-col divide-y divide-line">
        {faq.map(([q, a]) => (
          <details key={q} className="py-2">
            <summary className="cursor-pointer font-semibold text-[0.875rem]">{q}</summary>
            <p className="mt-1 text-[0.8125rem] text-ink-2 break-words">{a}</p>
          </details>
        ))}
      </div>
      <p className="mt-3 text-[0.75rem] text-ink-3">{market ? "Crypto prices move fast." : "Meme coins are risky."} Only use money you can afford to lose.</p>
    </section>
  );
}

function TokenCheck({ coin }: { coin: ExtCoin }) {
  const [open, setOpen] = useState(false);
  const checked = !!coin.checkedAt;
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(v * 100 < 1 && v > 0 ? 1 : 0)}%`);
  const rows: { ok: boolean | null; text: string }[] = checked
    ? [
        { ok: true, text: isSolExt(coin.network) ? "Can be sold (nobody can freeze or lock it)" : "Can be sold (checked by a sale simulation)" },
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

function TradeBox({ coin, initialSide = "buy", bare = false }: { coin: ExtCoin; initialSide?: "buy" | "sell"; bare?: boolean }) {
  const w = useWallet();
  const { address } = w;
  const route = extRoute(coin.network, !!w.embedded);
  const cross = route.kind === "cross" ? route : null;
  const chain = route.kind === "same" ? chainForNetwork(coin.network) : null;
  const live = !IS_TESTNET && (!!chain || !!cross);
  const autoChain = autoForNetwork(coin.network);
  const canAuto = !IS_TESTNET && autoReady(autoChain);
  const [side, setSide] = useState<"buy" | "sell" | "auto">(initialSide);
  const [usd, setUsd] = useState("25");
  const [pct, setPct] = useState(100);
  const [held, setHeld] = useState<bigint | null>(null);
  const [decimals, setDecimals] = useState<number | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  // when the shown price was fetched: a fresh one is used as is (no second wait on Buy)
  const quoteAt = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const amount = Number(usd.replace(",", ".")) || 0;
  const estimate = coin.priceUsd ? (amount * (1 - FEE)) / coin.priceUsd : null;
  // small amounts keep 3 significant digits ($25 of Bitcoin is 0.000223 BTC, not 0.00)
  const fmt = (t: number) =>
    t >= 1e9 ? `${(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `${(t / 1e6).toFixed(2)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(1)}K` : t >= 1 || t <= 0 ? t.toFixed(2) : String(Number(t.toPrecision(3)));
  const token = coin.address as Address;
  const coinKey = cross ? `x${cross.there.chainId}` : chain ? `s${chain.chain.id}` : "";

  // the user's coins, read on the chain the coin lives on
  const loadHeld = useCallback(async () => {
    if (!address) return setHeld(null);
    const read = cross
      ? xClient(cross.there).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      : chain
        ? clientFor(chain).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] })
        : autoChain
          ? raceClient(autoChain).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] })
          : null;
    if (!read) return setHeld(null);
    setHeld((await read.catch(() => 0n)) as bigint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, coinKey, token]);
  useEffect(() => {
    void loadHeld();
  }, [loadHeld]);
  useEffect(() => {
    if (side !== "auto" || decimals !== null || !autoChain) return;
    raceClient(autoChain)
      .readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
      .then((d) => setDecimals(Number(d)))
      .catch(() => setDecimals(null));
  }, [side, decimals, autoChain, token]);

  const raw = side === "buy" ? BigInt(Math.floor(amount * 1e6)) : side === "sell" && held !== null ? (held * BigInt(pct)) / 100n : 0n;
  useEffect(() => {
    setQuote(null);
    setError("");
    if (!live || !address || raw <= 0n || side === "auto") return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const q = cross
        ? side === "buy"
          ? quoteCrossBuy({ user: address, home: cross.home, there: cross.there, token, amountHome: raw, signal: ctrl.signal })
          : quoteCrossSell({ user: address, home: cross.home, there: cross.there, token, amount: raw, signal: ctrl.signal })
        : quoteSwap({ chain: chain!, account: address, side, token, amount: raw, signal: ctrl.signal });
      q.then((v) => {
        quoteAt.current = Date.now();
        setQuote(v);
      }).catch((e) => !ctrl.signal.aborted && setError(friendlyError(e)));
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, address, side, raw.toString(), token, coinKey]);

  async function go() {
    if (!quote || !address || side === "auto") return;
    try {
      setBusy(side === "buy" ? "Buying…" : "Selling…");
      const step = (m: string) => setBusy(m);
      let tx: Hex;
      let chainId: number;
      if (cross) {
        const s: ExtSenders = {
          user: address,
          sendHome: (c, calls, onStep) => w.send(c, calls, onStep),
          // the coin's chain: email accounts pay the network fee from their own gas there
          sendThere: (c, calls, onStep) => (w.embedded ? w.sendOwnGas(c, calls, onStep) : w.send(c, calls, onStep)),
        };
        if (side === "buy") {
          const r = await crossExtBuy({ s, home: cross.home, there: cross.there, token, amountHome: raw, onStep: step });
          tx = r.tx;
          chainId = cross.home.chainId;
        } else {
          const r = await crossExtSell({ s, home: cross.home, there: cross.there, token, amount: raw, onStep: step });
          tx = r.tx;
          chainId = cross.there.chainId;
        }
        toast(side === "buy" ? `Buying $${coin.symbol}: arriving on ${cross.there.short} in a few seconds ✓` : `Sold $${coin.symbol}: USDC arriving on Base in a few seconds ✓`);
      } else {
        // a fresh price for exactly what's on screen now (the shown one can be minutes old)
        const fresh = Date.now() - quoteAt.current < 12_000 ? quote : (setBusy("Getting the price…"), await quoteSwap({ chain: chain!, account: address, side, token, amount: raw }));
        setBusy(side === "buy" ? "Buying…" : "Selling…");
        tx = await w.send(chain!.chain, quoteCalls(fresh, chain!), step);
        chainId = chain!.chain.id;
        toast(side === "buy" ? `Bought $${coin.symbol} ✓` : `Sold $${coin.symbol} ✓`);
      }
      void reportExtTrade({ chainId, tx, network: coin.network, coin: token, side });
      // it shows under "You" right away (the server's verified record follows)
      if (side === "buy") rememberExtBuy(address, { network: coin.network, address: token, name: coin.name, symbol: coin.symbol, image: coin.image });
      afterTrade();
      for (const ms of [1500, 6000, 15000, 30000]) setTimeout(() => void loadHeld(), ms);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const tabs = (canAuto ? ["buy", "sell", "auto"] : ["buy", "sell"]) as ("buy" | "sell" | "auto")[];
  return (
    <aside className={bare ? "" : "rounded-3xl border border-line bg-surface p-4 sm:p-5"}>
      <div className={"grid gap-1 p-1 rounded-2xl bg-paper " + (canAuto ? "grid-cols-3" : "grid-cols-2")} role="tablist" aria-label="Buy, sell or auto">
        {tabs.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={"h-11 rounded-xl font-bold " + (side === s ? (s === "buy" ? "bg-up text-on-accent" : s === "sell" ? "bg-danger text-white" : "bg-ink text-paper") : "text-ink-2")}
          >
            {s === "buy" ? "Buy" : s === "sell" ? "Sell" : "Auto"}
          </button>
        ))}
      </div>
      {side === "auto" && autoReady(autoChain) ? (
        <AutoPanel
          coin={{ address: token, symbol: coin.symbol, decimals: decimals ?? 18, kind: "ext", network: coin.network }}
          coinChain={autoChain}
          priceUsd={coin.priceUsd ?? null}
          holdings={held}
        />
      ) : (
        <>
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
            <p className="text-[0.75rem] text-ink-3 mt-2">You hold {held > 0n ? "some" : "no"} ${coin.symbol}{cross ? ` on ${cross.there.short}` : ""}</p>
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
          {!IS_TESTNET && route.kind === "none" && <p className="mt-3 text-[0.8125rem] text-ink-3">{route.why}</p>}
          {cross && (
            <p className="text-[0.6875rem] text-ink-3 mt-2">
              {side === "buy"
                ? `Paid with your USDC on Base; the coin arrives on ${cross.there.short}. If you have almost no ${cross.there.chain.nativeCurrency.symbol} there, $${(Number(gasTopup(cross.there.chainId)) / 1e6).toFixed(2)} of it comes along so you can sell later.`
                : `Your USDC arrives on Base. The network fee on ${cross.there.short} is paid in ${cross.there.chain.nativeCurrency.symbol}.`}
            </p>
          )}
          <p className="text-[0.6875rem] text-ink-3 mt-2">Best price across DEXs, paid in USDC.</p>
        </>
      )}
    </aside>
  );
}
