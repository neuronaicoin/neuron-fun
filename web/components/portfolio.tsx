"use client";

/**
 * Header balance ("$120.16 | ＋"), the Portfolio sheet (cash, coins, profit
 * and loss, quick sell) and the host that shows Deposit / Withdraw / Sell.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Sheet } from "./chrome";
import { CoinAvatar } from "./coins";
import { DepositSheet, WithdrawSheet } from "./money";
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
  type Position,
} from "@/lib/portfolio";

/** Logged-in header control: total balance, and the cash left to spend under it. Opens the portfolio. */
export function BalancePill() {
  const { portfolio } = useMoney();
  const total = portfolio ? money(portfolio.totalUsd) : null;
  const cash = portfolio ? money(portfolio.cashUsd) : null;
  return (
    <div className="h-11 flex items-center gap-1 pl-1 pr-1 rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_18px_rgba(0,0,0,0.06)] shrink-0 hover:border-emerald/60 transition-colors">
      <button
        type="button"
        onClick={() => openMoney({ kind: "portfolio" })}
        aria-label={total ? `Your portfolio: ${total}, cash ${cash}` : "Your portfolio"}
        className="h-9 flex items-center gap-2 pl-1 pr-1.5 rounded-xl"
      >
        <span className="hidden sm:flex w-8 h-8 rounded-[0.625rem] bg-emerald-soft text-emerald items-center justify-center shrink-0" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="6" width="18" height="14" rx="3" />
            <path d="M3 10h18M16 15h2" />
          </svg>
        </span>
        {total ? (
          <span className="flex flex-col items-start leading-none min-w-[3.75rem]">
            <span className="font-mono text-[0.9375rem] font-bold tabular-nums tracking-tight text-ink">{total}</span>
            <span className="text-[0.6875rem] text-ink-3 mt-1 whitespace-nowrap">
              Cash <span className="font-mono text-up font-semibold tabular-nums">{cash}</span>
            </span>
          </span>
        ) : (
          <span className="shimmer inline-block w-16 h-5 rounded-md" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={() => openMoney({ kind: "deposit" })}
        aria-label="Add money"
        title="Add money"
        className="w-8 h-8 rounded-[0.625rem] bg-emerald text-on-accent flex items-center justify-center shrink-0 hover:bg-emerald-dark"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/** Keeps the money store in step with the wallet and shows whichever money sheet is open. */
export function MoneyHost() {
  const { address } = useWallet();
  const { sheet } = useMoney();
  useEffect(() => setMoneyAddress(address ?? null), [address]);
  if (!address || !sheet) return null;
  if (sheet.kind === "deposit") return <DepositSheet onClose={closeMoney} />;
  if (sheet.kind === "withdraw") return <WithdrawSheet onClose={closeMoney} />;
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
          <div className="h-12 w-48 rounded-xl bg-line/50 animate-pulse" />
          <div className="h-20 rounded-2xl bg-line/50 animate-pulse" />
          <div className="h-32 rounded-2xl bg-line/50 animate-pulse" />
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
                    {money(c.usd)} <span className="text-ink-3">· {(Number(c.wei) / 1e18).toFixed(5)} {CASH_SYMBOL}</span>
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
          {p.positions.length === 0 ? (
            <p className="text-[0.875rem] text-ink-2 py-2">No coins yet. Buy something and it shows up here with its profit or loss.</p>
          ) : (
            <ul>
              {p.positions.map((pos) => (
                <PositionRow key={pos.coin.id} pos={pos} />
              ))}
            </ul>
          )}
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
