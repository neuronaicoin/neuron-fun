"use client";

/**
 * Header balance ("$120.16 | ＋": Deposit and Withdraw in one sheet), the Portfolio sheet (cash, coins, profit
 * and loss, quick sell) and the host that shows Deposit / Withdraw / Sell.
 */
import { BaseDepositSheet, BaseWithdrawSheet } from "./basemoney";
import { USD_MODE, IS_TESTNET } from "@/lib/config";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { onPending, pendingList, returningUsd, watchPending, type Pending } from "@/lib/racecross";
import { raceHref, type RacePosition } from "@/lib/race";
import { Sheet } from "./chrome";
import { CoinAvatar, SkeletonRows } from "./coins";
import { QuickTrade } from "./trade";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { coinHref } from "@/lib/data";
import { shortAddr } from "@/lib/format";
import {
  CASH_SYMBOL,
  capText,
  closeMoney,
  money,
  openMoney,
  pctText,
  refreshPortfolio,
  setMoneyAddress,
  signed,
  tokensText,
  useMoney,
  type Portfolio,
  type Position,
} from "@/lib/portfolio";
import { extNetwork } from "@/lib/extcoins";
import type { ExtHolding } from "@/lib/extheld";

/** Logged-in header control: total balance, and the cash left to spend under it. Opens the portfolio. */
const NO_PENDING: Pending[] = [];

/** The last balance shown on this device for `address` (so a reload starts from it, not from a blank). */
function lastBalance(address: string | null): { total: string; cash: string } | null {
  if (!address || typeof localStorage === "undefined") return null;
  try {
    const v = JSON.parse(localStorage.getItem("sasa-balance") ?? "null") as { address?: string; total?: string; cash?: string } | null;
    return v && v.address === address.toLowerCase() && v.total && v.cash ? { total: v.total, cash: v.cash } : null;
  } catch {
    return null;
  }
}

export function BalancePill() {
  const { portfolio } = useMoney();
  const { address: signedIn, hintAddress, embedded } = useWallet();
  const address = signedIn ?? hintAddress;
  const [last, setLast] = useState<{ total: string; cash: string } | null>(null);
  useEffect(() => setLast(lastBalance(address)), [address]);
  const total = portfolio ? money(portfolio.totalUsd) : (last?.total ?? null);
  const cash = portfolio ? money(portfolio.cashUsd) : (last?.cash ?? null);
  // dollars on their way back to Base from a sale on another chain (sasa accounts)
  const pending = useSyncExternalStore(onPending, pendingList, () => NO_PENDING);
  const coming = embedded ? returningUsd(pending) : 0;
  useEffect(() => {
    if (embedded && pending.length) watchPending();
  }, [embedded, pending.length]);
  // The forum pages are plain HTML: leave them the last known balance to show.
  useEffect(() => {
    if (!signedIn || !portfolio || !total || !cash) return;
    try {
      localStorage.setItem("sasa-balance", JSON.stringify({ address: signedIn.toLowerCase(), total, cash, at: Date.now() }));
    } catch {}
  }, [signedIn, portfolio, total, cash]);
  return (
    <div className="h-12 flex items-center gap-1 pl-1 pr-1 rounded-xl shrink-0">
      <button
        type="button"
        onClick={() => openMoney({ kind: "portfolio" })}
        aria-label={total ? `Total ${total} (cash plus your coins), cash to spend ${cash}` : "Your portfolio"}
        className="h-11 flex items-center gap-2 pl-1 pr-1.5 rounded-xl"
      >
        <span className="hidden sm:flex w-8 h-8 rounded-lg text-ink-3 items-center justify-center shrink-0" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="6" width="18" height="14" rx="3" />
            <path d="M3 10h18M16 15h2" />
          </svg>
        </span>
        {total ? (
          <span className="flex flex-col items-start leading-none min-w-[3.75rem]">
            <span className="whitespace-nowrap">
              <span className="text-[0.75rem] text-ink-3 mr-1">Total</span>
              <span className="font-mono text-[1.0625rem] font-bold tabular-nums tracking-tight text-ink">{total}</span>
            </span>
            <span className="text-[0.75rem] text-ink-3 mt-1 whitespace-nowrap">
              Cash <span className="font-mono text-ink-2 font-semibold tabular-nums text-[0.8125rem]">{cash}</span>
              {coming > 0 && (
                <span className="text-emerald-dark font-semibold" title="On its way back to your balance">
                  {" "}+{money(coming)}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="shimmer inline-block w-16 h-5 rounded-md" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={() => openMoney({ kind: "deposit" })}
        aria-label="Deposit or withdraw"
        title="Deposit or withdraw"
        className="w-10 h-10 rounded-xl bg-emerald text-on-accent flex items-center justify-center shrink-0 hover:bg-emerald-dark"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/** Keeps the money store in step with the wallet and shows whichever money sheet is open. */
export function MoneyHost() {
  const { address, hintAddress } = useWallet();
  const { sheet } = useMoney();
  // the balance starts loading for the person signed in last time while their login comes back
  const who = address ?? hintAddress;
  useEffect(() => setMoneyAddress(who ?? null), [who]);
  // ?money=deposit (or withdraw / portfolio) opens that sheet, e.g. from the forum header.
  useEffect(() => {
    if (!address) return;
    const q = new URLSearchParams(window.location.search);
    const m = q.get("money");
    if (m === "deposit" || m === "withdraw" || m === "portfolio") {
      openMoney({ kind: m });
      q.delete("money");
      const rest = q.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    }
  }, [address]);
  if (!address || !sheet) return null;
  // Dollar edition: USDC in and out (the ETH sheets stay for chains without USDC).
  // Money in and out: USDC on the Base network only (testnet and mainnet alike).
  if (sheet.kind === "deposit") return <BaseDepositSheet onClose={closeMoney} />;
  if (sheet.kind === "withdraw") return <BaseWithdrawSheet onClose={closeMoney} />;
  if (sheet.kind === "sell") return <SellSheet coin={sheet.coin} pct={sheet.pct} />;
  return <PortfolioSheet />;
}

function SellSheet({ coin, pct }: { coin: Position["coin"]; pct: number }) {
  const { portfolio } = useMoney();
  return (
    <Sheet title={`Sell $${coin.symbol}`} onClose={() => openMoney({ kind: "portfolio" })}>
      <QuickTrade
        coin={coin}
        ethUsd={portfolio?.ethUsd ?? null}
        initialSide="sell"
        initialSellPct={pct}
        bare
        onTraded={() => {
          void refreshPortfolio();
        }}
      />
    </Sheet>
  );
}

function PortfolioSheet() {
  const { address, embedded, email, walletName, disconnect } = useWallet();
  const { portfolio: p } = useMoney();
  const [showCash, setShowCash] = useState(false);

  return (
    <Sheet title="Portfolio" onClose={closeMoney}>
      {!p ? (
        <div className="grid gap-3" aria-busy="true">
          <div className="shimmer h-12 w-48 rounded-xl" />
          <div className="shimmer h-20 rounded-2xl" />
          <SkeletonRows rows={3} avatar="square" />
        </div>
      ) : (
        <>
          <div className="-mt-2">
            <div className="font-display text-[2.25rem] sm:text-[2.5rem] font-bold tracking-tight leading-none">{money(p.totalUsd)}</div>
            {p.coinsUsd > 0 && (
              <div className={"font-mono text-[0.875rem] mt-1.5 " + (p.dayUsd >= 0 ? "text-up" : "text-danger")}>
                {signed(p.dayUsd)} ({pctText(p.dayPct)}) today
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-4">
            <button
              type="button"
              onClick={() => setShowCash(!showCash)}
              aria-expanded={showCash}
              className="text-left rounded-2xl bg-paper border border-line px-3.5 py-3 hover:border-emerald"
            >
              <span className="block text-[0.75rem] text-ink-3">Cash</span>
              <span className="block font-mono text-[1.0625rem] mt-0.5">{money(p.cashUsd)}</span>
              <span className="block text-[0.75rem] text-ink-3 mt-0.5">{CASH_SYMBOL} {showCash ? "▴" : "▾"}</span>
            </button>
            <div className="rounded-2xl bg-paper border border-line px-3.5 py-3">
              <span className="block text-[0.75rem] text-ink-3">Coins</span>
              <span className="block font-mono text-[1.0625rem] mt-0.5">{money(p.coinsUsd)}</span>
              {p.positions.length > 0 ? (
                <span className={"block text-[0.75rem] mt-0.5 " + (p.openPnlUsd >= 0 ? "text-up" : "text-danger")}>{signed(p.openPnlUsd)} open</span>
              ) : p.racePositions.length > 0 ? (
                <span className="block text-[0.75rem] text-ink-3 mt-0.5">{p.racePositions.length} coin{p.racePositions.length === 1 ? "" : "s"}</span>
              ) : (
                <span className="block text-[0.75rem] text-ink-3 mt-0.5">none yet</span>
              )}
            </div>
          </div>
          {showCash && (
            <ul className="mt-2 rounded-2xl bg-paper border border-line px-3.5 py-1 text-[0.8125rem]">
              {p.cashByChain.map((c) => (
                <li key={c.chain.key} className="flex justify-between py-2 border-t border-line first:border-t-0">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: c.chain.color }} aria-hidden="true" />
                    {c.chain.name}
                  </span>
                  <span className="font-mono">
                    {money(c.usd)}
                    {!USD_MODE && <span className="text-ink-3"> · {(Number(c.wei) / 1e18).toFixed(5)} {CASH_SYMBOL}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-2 mt-3">
            <button type="button" onClick={() => openMoney({ kind: "deposit" })} className="h-12 rounded-xl bg-emerald text-on-accent font-bold hover:bg-emerald-dark">
              ＋ Deposit
            </button>
            <button type="button" onClick={() => openMoney({ kind: "withdraw" })} className="h-12 rounded-xl border border-line font-semibold hover:border-emerald">
              Withdraw
            </button>
          </div>

          <div className="flex items-baseline justify-between mt-6 mb-1">
            <h3 className="font-display font-semibold text-[1rem]">Your coins</h3>
            {p.realizedUsd !== 0 && (
              <span className="text-[0.8125rem] text-ink-3">
                Realized: <b className={p.realizedUsd >= 0 ? "text-up" : "text-danger"}>{signed(p.realizedUsd)}</b>
              </span>
            )}
          </div>
          {p.positions.length === 0 && p.racePositions.length === 0 && p.extPositions.length === 0 ? (
            <p className="text-[0.875rem] text-ink-2 py-2">No coins yet. Buy something and it shows up here.</p>
          ) : (
            <ul>
              {p.racePositions.map((pos) => (
                <RacePositionRow key={pos.coin.id} pos={pos} />
              ))}
              {p.positions.map((pos) => (
                <PositionRow key={pos.coin.id} pos={pos} />
              ))}
              {p.extPositions.map((h) => (
                <ExtPositionRow key={`${h.network}:${h.address}`} h={h} />
              ))}
            </ul>
          )}
          {p.futures && <FuturesBlock f={p.futures} />}
        </>
      )}

      <div className="mt-6 pt-4 border-t border-line text-[0.8125rem] text-ink-3">
        {embedded && email && <p className="mb-1">Signed in as <span className="text-ink-2">{email}</span></p>}
        {!embedded && walletName && <p className="mb-1">Connected with {walletName}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Your address <span className="font-mono text-ink-2">{address ? shortAddr(address) : ""}</span>
          </span>
          <button
            type="button"
            className="text-emerald font-semibold"
            onClick={() => address && navigator.clipboard?.writeText(address).then(() => toast("Address copied")).catch(() => {})}
          >
            Copy
          </button>
          <button
            type="button"
            className="text-ink-3 hover:text-ink ml-auto"
            onClick={() => {
              closeMoney();
              disconnect();
            }}
          >
            {embedded ? "Log out" : "Disconnect"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function PositionRow({ pos, big = false }: { pos: Position; big?: boolean }) {
  const { coin } = pos;
  return (
    <li className="py-3 border-t border-line first:border-t-0">
      <div className="flex items-center gap-3">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={40} />
        <Link href={coinHref(coin)} onClick={closeMoney} className="min-w-0 flex-1">
          <span className="block font-semibold truncate">{coin.name}</span>
          <span className="block text-[0.8125rem] text-ink-3">
            {tokensText(pos.tokens)} ${coin.symbol}
          </span>
        </Link>
        <div className="text-right font-mono shrink-0">
          <div className={big ? "text-[1.0625rem] font-semibold" : ""}>{money(pos.valueUsd)}</div>
          {pos.pnlUsd !== null && (
            <div className={(big ? "text-[0.875rem] font-semibold " : "text-[0.8125rem] ") + (pos.pnlUsd >= 0 ? "text-up" : "text-danger")}>
              {signed(pos.pnlUsd)}
              {pos.pnlPct !== null ? ` (${pctText(pos.pnlPct)})` : ""}
            </div>
          )}
        </div>
      </div>
      {(pos.costUsd !== null || pos.avgMcapUsd !== null) && (
        <div className={"flex justify-between gap-3 mt-1.5 " + (big ? "text-[0.8125rem] text-ink-2" : "text-[0.75rem] text-ink-3")}>
          <span>{pos.costUsd !== null ? <>Cost <b className="font-mono font-semibold text-ink">{money(pos.costUsd)}</b></> : ""}</span>
          <span>{pos.avgMcapUsd !== null ? <>Avg. buy <b className="font-mono font-semibold text-ink">{capText(pos.avgMcapUsd)}</b> mcap</> : ""}</span>
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5 mt-2" role="group" aria-label={`Quick sell ${coin.symbol}`}>
        {[25, 50, 100].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => openMoney({ kind: "sell", coin, pct: v })}
            className="h-9 rounded-xl border border-line text-[0.8125rem] font-bold text-danger hover:border-danger"
          >
            {v === 100 ? "Sell all" : `Sell ${v}%`}
          </button>
        ))}
      </div>
    </li>
  );
}

/** A race coin held: value now, coins per chain; selling happens on the race page. */
export function RacePositionRow({ pos, big = false }: { pos: RacePosition; big?: boolean }) {
  const { coin } = pos;
  return (
    <li className="py-3 border-t border-line first:border-t-0">
      <Link href={raceHref(coin.id)} onClick={closeMoney} className="flex items-center gap-3">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold truncate">{coin.name}</span>
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3 min-w-0">
            <span className="truncate">
              {tokensText(pos.tokens)} ${coin.symbol}
            </span>
            {pos.chains.map((c) => (
              <span key={c.chain.chainId} title={c.chain.name} className="w-2 h-2 rounded-full shrink-0" style={{ background: c.chain.color }} aria-hidden="true" />
            ))}
          </span>
        </span>
        <span className="text-right shrink-0">
          <span className={"block font-mono " + (big ? "text-[1.0625rem] font-semibold" : "")}>{money(pos.valueUsd)}</span>
          <span className="block text-[0.75rem] text-emerald-dark font-semibold">Trade →</span>
        </span>
      </Link>
    </li>
  );
}

/** A coin from another DEX (or Market) bought on sasa: value now; trading happens on its page. */
export function ExtPositionRow({ h, big = false }: { h: ExtHolding; big?: boolean }) {
  const net = extNetwork(h.network);
  return (
    <li className="py-3 border-t border-line first:border-t-0">
      <Link href={h.href} onClick={closeMoney} className="flex items-center gap-3">
        <CoinAvatar logo={h.image ?? ""} symbol={h.symbol} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold truncate">{h.name}</span>
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3 min-w-0">
            <span className="truncate">
              {tokensText(h.tokens)} ${h.symbol}
            </span>
            {net && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: net.color }} title={net.label} aria-hidden="true" />}
            {net && <span className="shrink-0">{net.label}</span>}
          </span>
        </span>
        <span className="text-right shrink-0">
          <span className={"block font-mono " + (big ? "text-[1.0625rem] font-semibold" : "")}>{h.priceUsd ? money(h.valueUsd) : "—"}</span>
          <span className="block text-[0.75rem] text-emerald-dark font-semibold">Trade →</span>
        </span>
      </Link>
    </li>
  );
}

/** The futures account: balance and each open position with its profit; managed on the Futures page. */
export function FuturesBlock({ f, big = false }: { f: NonNullable<Portfolio["futures"]>; big?: boolean }) {
  return (
    <div className={big ? "" : "mt-5"}>
      {!big && <h3 className="font-display font-semibold text-[1rem] mb-1">Futures</h3>}
      <Link href="/perps/" onClick={closeMoney} className="flex items-center justify-between py-2 text-[0.875rem]">
        <span className="text-ink-2">Futures balance</span>
        <span className="font-mono font-semibold">{money(f.valueUsd)}</span>
      </Link>
      {f.positions.length === 0 ? (
        <p className="text-[0.8125rem] text-ink-3 pb-1">No open positions. {money(f.available)} free to trade.</p>
      ) : (
        <ul>
          {f.positions.map((pos) => (
            <li key={pos.coin} className="py-3 border-t border-line">
              <Link href={`/perps/?c=${encodeURIComponent(pos.coin)}`} onClick={closeMoney} className="flex items-center gap-3">
                <span className={"shrink-0 h-7 px-2.5 rounded-lg text-[0.75rem] font-bold flex items-center " + (pos.side === "long" ? "bg-emerald-soft text-up" : "bg-warn-bg text-danger")}>
                  {pos.side === "long" ? "Long" : "Short"} {pos.lev}x
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold truncate">{pos.coin}</span>
                  <span className="block text-[0.8125rem] text-ink-3 truncate">Size {money(Math.abs(pos.value))} · margin {money(pos.margin)}</span>
                </span>
                <span className="text-right shrink-0">
                  <span className={"block font-mono font-semibold " + (pos.pnl >= 0 ? "text-up" : "text-danger") + (big ? " text-[1.0625rem]" : "")}>{signed(pos.pnl)}</span>
                  <span className="block text-[0.75rem] text-emerald-dark font-semibold">Manage →</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
