"use client";

/**
 * Copy trading: your signals (Apply / Reject, several at once), how copying
 * each trader has worked out, and the traders whose copiers did best.
 * Nothing trades by itself; every signal waits for the person.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton, Sheet } from "@/components/chrome";
import { toast } from "@/components/alerts";
import { CoinAvatar, Skeleton, timeAgo, usd } from "@/components/coins";
import { ProfileLink } from "@/components/social";
import { QuickTrade } from "@/components/trade";
import { chainById } from "@/lib/config";
import { fetchCoin, nativePerToken, type Coin } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { fetchPrices } from "@/lib/price";
import { useProfiles } from "@/lib/social";
import { actOnSignal, fetchCopyBoard, fetchCopying, fetchSignals, type BoardRow, type CopyResult, type CopySetting, type Signal } from "@/lib/copy";

type Tab = "signals" | "copies" | "best";
const RAN = 0.25; // the price moved this much above the trader's since they bought

export default function CopyPage() {
  const { address, signMessage } = useWallet();
  const [tab, setTab] = useState<Tab>("signals");
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [coins, setCoins] = useState<Map<string, Coin>>(new Map());
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [queue, setQueue] = useState<number[]>([]);
  const [focus, setFocus] = useState<number | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const s = Number(q.get("s"));
    if (Number.isInteger(s) && s > 0) setFocus(s);
    if (q.get("tab") === "best") setTab("best");
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!address) return;
    setError("");
    try {
      const list = await fetchSignals(signMessage);
      setSignals(list);
      const need = [...new Set(list.map((s) => s.coinId))];
      const got = await Promise.all(need.map((id) => fetchCoin(id).then((r) => r.coin).catch(() => null)));
      setCoins(new Map(got.filter((c): c is Coin => !!c).map((c) => [c.id, c])));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [address, signMessage]);

  useEffect(() => {
    setSignals(null);
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const traders = useMemo(() => (signals ?? []).map((s) => s.trader), [signals]);
  const profiles = useProfiles(traders);
  const pending = (signals ?? []).filter((s) => s.status === "pending");
  const earlier = (signals ?? []).filter((s) => s.status !== "pending").slice(0, 20);

  /** Change of this chain's price since the trader's trade (0.1 = +10%). */
  const moveOf = (s: Signal): number | null => {
    const c = coins.get(s.coinId)?.curves.find((k) => k.chain.chain.id === s.chainId);
    if (!c || !(s.traderPrice > 0)) return null;
    return nativePerToken(c) / s.traderPrice - 1;
  };

  async function reject(ids: number[]) {
    try {
      for (const id of ids) await actOnSignal(signMessage, id, "reject");
      setSelected(new Set());
      toast(ids.length > 1 ? `${ids.length} signals rejected` : "Rejected");
      await load();
    } catch (e) {
      toast(friendlyError(e));
    }
  }

  if (!address) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.75rem]">Copy trading</h1>
        <p className="text-ink-2 mt-2">Copy traders you trust. Every trade waits for you to tap Apply or Reject.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
        <Link href="/copy/?tab=best" onClick={() => setTab("best")} className="mt-4 inline-block font-bold text-emerald">
          See who&apos;s best to copy
        </Link>
      </div>
    );
  }

  const current = queue.length ? (signals ?? []).find((s) => s.id === queue[0]) : undefined;
  const currentCoin = current ? coins.get(current.coinId) : undefined;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-10 pb-32">
      <h1 className="font-display font-bold text-[1.625rem] sm:text-[2rem]">Copy trading</h1>
      <div className="mt-4 flex gap-1 p-1 rounded-2xl bg-paper w-fit max-w-full overflow-x-auto" role="tablist">
        {(
          [
            ["signals", `Signals${pending.length ? ` (${pending.length})` : ""}`],
            ["copies", "Your copies"],
            ["best", "Best to copy"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={"h-10 px-4 rounded-xl text-[0.875rem] font-semibold whitespace-nowrap " + (tab === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "signals" && (
        <>
          <p className="text-ink-3 mt-3 text-[0.9375rem]">Trades from the traders you copy. Nothing happens until you tap Apply.</p>
          {error && <p className="text-danger mt-4">{error}</p>}
          {signals === null && !error && <Skeleton className="h-40 mt-4 rounded-3xl" />}
          {signals && pending.length === 0 && (
            <div className="mt-4 rounded-3xl border border-line bg-surface p-8 text-center text-ink-2">
              No new signals. When a trader you copy buys or sells, it shows up here and on your phone.
              <div className="mt-3">
                <button type="button" onClick={() => setTab("best")} className="font-bold text-emerald">
                  Find traders to copy
                </button>
              </div>
            </div>
          )}
          <div className="grid gap-3 mt-4">
            {pending.map((s) => (
              <SignalCard
                key={s.id}
                s={s}
                profile={profiles.get(s.trader)}
                move={moveOf(s)}
                focused={focus === s.id}
                selected={selected.has(s.id)}
                onSelect={(on) =>
                  setSelected((p) => {
                    const n = new Set(p);
                    if (on) n.add(s.id);
                    else n.delete(s.id);
                    return n;
                  })
                }
                onApply={() => setQueue([s.id])}
                onReject={() => void reject([s.id])}
              />
            ))}
          </div>
          {earlier.length > 0 && (
            <>
              <h2 className="font-display font-semibold text-[1.0625rem] mt-8 mb-3">Earlier</h2>
              <div className="grid gap-2">
                {earlier.map((s) => {
                  const m = moveOf(s);
                  const p = profiles.get(s.trader);
                  return (
                    <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[0.875rem]">
                      <span className={"font-semibold " + (s.status === "applied" ? "text-up" : "text-ink-3")}>{s.status === "applied" ? "Applied" : "Rejected"}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {s.isBuy ? "Buy" : "Sell"} ${s.coin?.symbol ?? "?"} from {p ? (p.username ? `@${p.username}` : `${p.address.slice(0, 6)}…`) : "…"}
                      </span>
                      {m !== null && (
                        <span className={"font-mono " + (m >= 0 ? "text-up" : "text-danger")} title="Price change since the trader's trade">
                          {m >= 0 ? "+" : "−"}
                          {Math.abs(m * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[0.75rem] text-ink-3 mt-2">The % is how the price moved since the trader&apos;s trade, so you can see how rejected signals turned out too.</p>
            </>
          )}
        </>
      )}

      {tab === "copies" && <CopiesTab ethUsd={ethUsd} />}
      {tab === "best" && <BestTab />}

      {tab === "signals" && selected.size > 0 && (
        <div className="fixed left-0 right-0 bottom-0 z-40 bg-paper border-t border-line px-4 pt-3 safe-bottom">
          <div className="max-w-3xl mx-auto flex gap-2">
            <button type="button" onClick={() => void reject([...selected])} className="h-12 px-4 rounded-2xl border border-line font-semibold">
              Reject {selected.size}
            </button>
            <button
              type="button"
              onClick={() => setQueue(pending.filter((s) => selected.has(s.id)).map((s) => s.id))}
              className="flex-1 h-12 rounded-2xl bg-emerald text-on-accent font-bold"
            >
              Apply selected ({selected.size})
            </button>
          </div>
        </div>
      )}

      {current && (
        <Sheet
          title={queue.length > 1 ? `Signal 1 of ${queue.length}` : current.isBuy ? `Buy $${current.coin?.symbol ?? ""}` : `Sell $${current.coin?.symbol ?? ""}`}
          onClose={() => setQueue([])}
        >
          {!currentCoin ? (
            <p className="text-ink-2">This coin couldn&apos;t be loaded. Try again in a moment.</p>
          ) : (
            <QuickTrade
              key={current.id}
              coin={currentCoin}
              ethUsd={ethUsd}
              bare
              initialSide={current.isBuy ? "buy" : "sell"}
              initialUsd={current.suggestUsd !== null ? String(Math.round(current.suggestUsd * 100) / 100) : undefined}
              initialSellPct={current.sellPct !== null ? nearestPct(current.sellPct) : undefined}
              initialChainId={current.chainId}
              onTraded={() => {}}
              onDone={async ({ hash }) => {
                try {
                  await actOnSignal(signMessage, current.id, "apply", hash);
                } catch {
                  // the trade went through; the signal just stays pending until it expires
                }
                setSelected((p) => {
                  const n = new Set(p);
                  n.delete(current.id);
                  return n;
                });
                setTimeout(() => {
                  setQueue((q) => q.slice(1));
                  void load();
                }, 1200);
              }}
            />
          )}
          {queue.length > 1 && (
            <button type="button" onClick={() => setQueue((q) => q.slice(1))} className="mt-3 w-full h-11 rounded-xl border border-line text-ink-2 font-semibold">
              Skip this one
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}

/** The sell box offers 25 / 50 / 75 / 100%. */
const nearestPct = (p: number) => [25, 50, 75, 100].reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a), 100);

function SignalCard({
  s,
  profile,
  move,
  focused,
  selected,
  onSelect,
  onApply,
  onReject,
}: {
  s: Signal;
  profile: ReturnType<typeof useProfiles> extends Map<string, infer P> ? P | undefined : never;
  move: number | null;
  focused: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onApply: () => void;
  onReject: () => void;
}) {
  const chain = chainById(s.chainId);
  const ran = s.isBuy && move !== null && move > RAN;
  return (
    <article className={"rounded-3xl border bg-surface p-4 " + (selected || focused ? "border-emerald" : "border-line")}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label="Select this signal" className="mt-2 w-5 h-5 accent-[var(--color-emerald)] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {profile ? <ProfileLink profile={profile} size={28} /> : <span className="font-semibold">…</span>}
            <span className={s.isBuy ? "text-up font-bold" : "text-danger font-bold"}>{s.isBuy ? "bought" : "sold"}</span>
            <Link href={`/coin/?id=${encodeURIComponent(s.coinId)}`} className="flex items-center gap-1.5 font-bold">
              {s.coin && <CoinAvatar logo={s.coin.logo} symbol={s.coin.symbol} size={22} />}${s.coin?.symbol ?? "?"}
            </Link>
          </div>
          <div className="text-[0.75rem] text-ink-3 mt-0.5">
            {chain?.short ?? "?"} · {timeAgo(s.createdAt)}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 rounded-2xl bg-paper p-3 text-[0.8125rem]">
        <div>
          <div className="text-[0.6875rem] text-ink-3">{s.isBuy ? "They spent" : "They sold"}</div>
          {s.isBuy ? (s.traderUsd !== null ? usd(s.traderUsd, 2) : "—") : `${s.sellPct ?? "?"}% of theirs`}
        </div>
        <div>
          <div className="text-[0.6875rem] text-ink-3">Price since then</div>
          <span className={move === null ? "" : move >= 0 ? "text-up font-semibold" : "text-danger font-semibold"}>
            {move === null ? "—" : `${move >= 0 ? "+" : "−"}${Math.abs(move * 100).toFixed(1)}%`}
          </span>
        </div>
        <div>
          <div className="text-[0.6875rem] text-ink-3">{s.isBuy ? "You'd buy" : "You'd sell"}</div>
          {s.isBuy ? (s.suggestUsd !== null ? usd(s.suggestUsd, 2) : "you choose") : `${s.sellPct ?? "?"}% of yours`}
        </div>
      </div>
      {ran && (
        <p className="mt-2 text-[0.8125rem] rounded-xl bg-warn-bg text-warn-ink px-3 py-2">
          The price is up {Math.round((move as number) * 100)}% since they bought. You&apos;d pay more than they did.
        </p>
      )}
      <div className="flex gap-2 mt-3">
        <button type="button" onClick={onReject} className="h-11 px-5 rounded-xl border border-line font-semibold text-ink-2">
          Reject
        </button>
        <button type="button" onClick={onApply} className={"flex-1 h-11 rounded-xl font-bold " + (s.isBuy ? "bg-up text-on-accent" : "bg-danger text-white")}>
          Apply
        </button>
      </div>
    </article>
  );
}

function CopiesTab({ ethUsd }: { ethUsd: number | null }) {
  const { signMessage } = useWallet();
  const [data, setData] = useState<{ copying: CopySetting[]; results: CopyResult[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchCopying(signMessage).then(setData).catch((e) => setError(friendlyError(e)));
  }, [signMessage]);
  const profiles = useProfiles((data?.copying ?? []).map((c) => c.trader));
  if (error) return <p className="text-danger mt-4">{error}</p>;
  if (!data) return <Skeleton className="h-40 mt-4 rounded-3xl" />;
  if (!data.copying.length) {
    return (
      <div className="mt-4 rounded-3xl border border-line bg-surface p-8 text-center text-ink-2">
        You&apos;re not copying anyone yet. Open a trader&apos;s profile with the Copyable badge and tap Copy.
      </div>
    );
  }
  return (
    <>
      <p className="text-ink-3 mt-3 text-[0.9375rem]">How your copied buys are doing, per trader. Tap a trader to change or stop.</p>
      <div className="grid gap-2 mt-4">
        {data.copying.map((c) => {
          const r = data.results.find((x) => x.trader === c.trader);
          const p = profiles.get(c.trader);
          const diff = r && r.paid > 0 ? (r.worth - r.paid) / 1e18 : null;
          return (
            <div key={c.trader} className="rounded-2xl border border-line bg-surface px-4 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                {p ? <ProfileLink profile={p} size={32} /> : <span>…</span>}
                <div className="text-[0.75rem] text-ink-3 mt-1">
                  {c.mode === "fixed" ? `${usd(c.amount, 2)} each` : `${c.amount}% of theirs`}
                  {c.copySells ? ", sells too" : ""} · applied {r?.applied ?? 0} of {(r?.applied ?? 0) + (r?.rejected ?? 0)}
                </div>
              </div>
              <div className="text-right">
                <div className={"font-mono font-semibold " + (diff === null ? "text-ink-3" : diff >= 0 ? "text-up" : "text-danger")}>
                  {diff === null ? "—" : ethUsd ? `${diff >= 0 ? "+" : "−"}${usd(Math.abs(diff * ethUsd), 2)}` : `${diff.toFixed(5)} ETH`}
                </div>
                <div className="text-[0.6875rem] text-ink-3">if still held</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BestTab() {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchCopyBoard(30)
      .then(setRows)
      .catch(() => setError("Couldn't load the list. Try again in a moment."));
  }, []);
  const profiles = useProfiles((rows ?? []).map((r) => r.trader));
  if (error) return <p className="text-danger mt-4">{error}</p>;
  if (!rows) return <Skeleton className="h-40 mt-4 rounded-3xl" />;
  return (
    <>
      <p className="text-ink-3 mt-3 text-[0.9375rem]">Traders who allow copying, ranked by how their copiers&apos; buys did in the last 30 days.</p>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-3xl border border-line bg-surface p-8 text-center text-ink-2">No one allows copying yet. Turn it on for yourself on the You page.</div>
      ) : (
        <div className="mt-4 rounded-3xl border border-line bg-surface overflow-x-auto">
          <table className="w-full text-[0.875rem]">
            <thead>
              <tr className="text-left text-[0.75rem] text-ink-3">
                <th className="px-4 py-2 font-semibold">#</th>
                <th className="px-2 py-2 font-semibold">Trader</th>
                <th className="px-2 py-2 font-semibold text-right">Copiers</th>
                <th className="px-4 py-2 font-semibold text-right">Copiers&apos; buys</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = profiles.get(r.trader);
                return (
                  <tr key={r.trader} className="border-t border-line">
                    <td className="px-4 py-3 text-ink-3">{i + 1}</td>
                    <td className="px-2 py-3">{p ? <ProfileLink profile={p} size={30} /> : "…"}</td>
                    <td className="px-2 py-3 text-right font-mono">{r.copiers}</td>
                    <td className={"px-4 py-3 text-right font-mono " + (r.avgReturn === null ? "text-ink-3" : r.avgReturn >= 0 ? "text-up" : "text-danger")}>
                      {r.avgReturn === null ? "no copies yet" : `${r.avgReturn >= 0 ? "+" : "−"}${Math.abs(r.avgReturn * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[0.75rem] text-ink-3 mt-3">Average change since each copied buy. Past results don&apos;t promise future ones.</p>
    </>
  );
}
