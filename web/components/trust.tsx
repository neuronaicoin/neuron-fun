"use client";

import { fetchLock, timeLeft } from "@/lib/lock";
import { useEffect, useState } from "react";
import { db, type Coin, type CurveInfo } from "@/lib/data";
import { Skeleton } from "./coins";

type Level = "good" | "warn" | "bad" | "info";
type Check = { level: Level; title: string; detail: string };

const SUPPLY = 1e9; // whole tokens per chain
const SKIP = ["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"];

async function readCurveHolders(curve: CurveInfo, creator: string) {
  const { data, error } = await db
    .from("balances")
    .select("holder,amount")
    .eq("chain_id", curve.chain.chain.id)
    .eq("token", curve.token.toLowerCase())
    .gt("amount", 0)
    .order("amount", { ascending: false })
    .limit(14);
  if (error) throw error;
  const rows = (data ?? [])
    .map((r) => ({ holder: (r.holder as string).toLowerCase(), amount: Number(r.amount) / 1e18 }))
    .filter(
      (r) =>
        r.holder !== curve.curve.toLowerCase() &&
        r.holder !== curve.chain.poolManager.toLowerCase() &&
        !SKIP.includes(r.holder)
    );
  const top10 = rows.slice(0, 10).reduce((s, r) => s + r.amount, 0) / SUPPLY;
  const creatorRow = rows.find((r) => r.holder === creator);
  let creatorShare = creatorRow ? creatorRow.amount / SUPPLY : 0;
  if (!creatorRow) {
    const c = await db
      .from("balances")
      .select("amount")
      .eq("chain_id", curve.chain.chain.id)
      .eq("token", curve.token.toLowerCase())
      .eq("holder", creator)
      .maybeSingle();
    creatorShare = c.data ? Number(c.data.amount) / 1e18 / SUPPLY : 0;
  }
  return { top10, creatorShare };
}

async function readChecks(coin: Coin): Promise<Check[]> {
  const creator = coin.creator.toLowerCase();
  const curves = coin.curves.filter((c) => c.state !== "closed" || coin.curves.length === 1);
  const [history, sells, shares] = await Promise.all([
    db.from("coin_list").select("id,graduated_chain").eq("creator", creator),
    db.from("trades").select("native_amount").eq("coin_id", coin.id).eq("trader", creator).eq("is_buy", false),
    Promise.all(curves.map((c) => readCurveHolders(c, creator))),
  ]);
  if (history.error) throw history.error;
  if (sells.error) throw sells.error;

  const checks: Check[] = [];

  // Creator's share: the highest across chains.
  const creatorMax = Math.max(0, ...shares.map((s) => s.creatorShare));
  const cp = (creatorMax * 100).toFixed(1);
  checks.push(
    creatorMax <= 0.05
      ? { level: "good", title: `Creator holds ${cp}%`, detail: "A small creator stake leaves little room for a big dump." }
      : creatorMax <= 0.15
        ? { level: "warn", title: `Creator holds ${cp}%`, detail: "A sizeable stake: the creator selling would move the price." }
        : { level: "bad", title: `Creator holds ${cp}%`, detail: "A large stake in one wallet. Selling it would drop the price hard." }
  );

  // Did the creator sell?
  const sold = (sells.data ?? []).reduce((s, r) => s + Number(r.native_amount), 0);
  checks.push(
    sold === 0
      ? { level: "good", title: "Creator hasn't sold", detail: "No sells from the creator's wallet on any chain." }
      : { level: "warn", title: `Creator sold ${(sold / 1e18).toFixed(4)} ETH worth`, detail: "Not a problem by itself, but worth knowing." }
  );

  // Concentration among the top 10 wallets (worst chain).
  const top = Math.max(0, ...shares.map((s) => s.top10));
  const tp = (top * 100).toFixed(1);
  checks.push(
    top <= 0.3
      ? { level: "good", title: `Top 10 wallets hold ${tp}%`, detail: "Ownership is spread out." }
      : top <= 0.5
        ? { level: "warn", title: `Top 10 wallets hold ${tp}%`, detail: "A few wallets own a lot of the coin." }
        : { level: "bad", title: `Top 10 wallets hold ${tp}%`, detail: "Most of the coin sits in a handful of wallets." }
  );

  // Creator track record.
  const made = history.data?.length ?? 0;
  const graduated = (history.data ?? []).filter((r) => r.graduated_chain !== null).length;
  checks.push(
    made <= 1
      ? { level: "info", title: "First coin from this creator", detail: "No track record yet, good or bad." }
      : graduated > 0
        ? { level: "good", title: `${graduated} of ${made} coins graduated`, detail: "This creator has launched coins that made it before." }
        : made >= 5
          ? { level: "warn", title: `${made} coins, none graduated`, detail: "This creator launches often; none have graduated so far." }
          : { level: "info", title: `${made} coins, none graduated yet`, detail: "A short track record so far." }
  );

  // Optional creator lock (v4).
  const until = await fetchLock(coin.id);
  if (until && until > Date.now()) {
    const at = new Date(until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    checks.unshift({
      level: "good",
      title: `Creator's coins locked until ${at}`,
      detail: `The creator chose to lock their coins at launch (${timeLeft(until)} left). Until then they can't sell or move them. Nobody can lift it early.`,
    });
  }

  // True for every sasa coin, by contract.
  checks.push({
    level: "good",
    title: "No owner, no minting",
    detail: "Fixed supply of 1,000,000,000. Liquidity is locked forever at graduation; sell-back stays open until then.",
  });
  return checks;
}

const DOT: Record<Level, string> = { good: "bg-up", warn: "bg-warn-ink", bad: "bg-danger", info: "bg-ink-3" };

/** Plain-language safety checks. Facts only; never a promise that a coin is safe. */
export function TrustCard({ coin, collapsible = false }: { coin: Coin; collapsible?: boolean }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  // Collapsible (phones): closed until tapped; the verdict stays visible either way.
  const [open, setOpen] = useState(!collapsible);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      readChecks(coin)
        .then((c) => alive && (setChecks(c), setFailed(false)))
        .catch(() => alive && setFailed(true));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id]);

  const worst: Level | null = checks
    ? checks.some((c) => c.level === "bad")
      ? "bad"
      : checks.some((c) => c.level === "warn")
        ? "warn"
        : "good"
    : null;
  const verdict =
    worst === "bad" ? "High risk signs" : worst === "warn" ? "Some things to watch" : worst === "good" ? "No red flags found" : "";

  return (
    <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={`trust-${coin.id}`}
            className="flex items-center gap-2 font-display font-bold text-[1.125rem] text-left min-w-0"
          >
            Safety check
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={"shrink-0 text-ink-3 transition-transform " + (open ? "rotate-180" : "")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        ) : (
          <h2 className="font-display font-bold text-[1.125rem]">Safety check</h2>
        )}
        {worst && (
          <span
            className={
              "inline-flex items-center gap-2 h-8 px-3 rounded-full text-[0.8125rem] font-semibold " +
              (worst === "bad" ? "bg-danger/15 text-danger" : worst === "warn" ? "bg-warn-bg text-warn-ink" : "bg-up/15 text-up")
            }
          >
            <span className={"w-2 h-2 rounded-full " + DOT[worst]} aria-hidden="true" />
            {verdict}
          </span>
        )}
      </div>
      {collapsible && !open && (
        <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[0.8125rem] text-ink-3">
          Tap to see what we checked
        </button>
      )}
      {open && (
      <div id={`trust-${coin.id}`}>
      {failed && !checks && <p className="text-[0.875rem] text-ink-3 mt-3">Could not load the checks right now.</p>}
      {!checks && !failed && <Skeleton className="h-40 mt-4" />}
      {checks && (
        <ul className="mt-4 grid gap-3">
          {checks.map((c) => (
            <li key={c.title} className="flex gap-3">
              <span className={"mt-2 w-2 h-2 rounded-full shrink-0 " + DOT[c.level]} aria-hidden="true" />
              <span>
                <span className="block text-[0.875rem] font-semibold">{c.title}</span>
                <span className="block text-[0.8125rem] text-ink-3 leading-snug mt-0.5">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.6875rem] text-ink-3 mt-4 leading-relaxed">
        Automatic checks from on-chain data. They can&apos;t tell you whether a coin will go up; meme coins are always risky.
      </p>
      </div>
      )}
    </div>
  );
}
