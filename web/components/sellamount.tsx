"use client";

/**
 * How much to sell, the same way on every coin page: type a dollar amount, or tap 25 / 50 / 75 %
 * / All. Typing clears the % pick and a % tap clears the typed amount. Shows what's held.
 */
export function SellAmount({
  usd,
  setUsd,
  pct,
  setPct,
  heldTokens,
  priceUsd,
  symbol,
}: {
  usd: string;
  setUsd: (v: string) => void;
  pct: number;
  setPct: (v: number) => void;
  /** coins held (whole coins), null while unknown */
  heldTokens: number | null;
  priceUsd: number | null;
  symbol: string;
}) {
  const typed = Number(usd.replace(",", ".")) || 0;
  const worth = heldTokens !== null && priceUsd ? heldTokens * priceUsd : null;
  return (
    <>
      <label className="mt-4 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-ink-3">
        <span className="text-ink-3 text-[1.375rem] mr-1">$</span>
        <input
          value={usd}
          onChange={(e) => {
            setUsd(e.target.value.replace(/[^0-9.,]/g, ""));
            setPct(0);
          }}
          inputMode="decimal"
          placeholder="Amount"
          aria-label="Amount to sell, in dollars"
          className="flex-1 min-w-0 bg-transparent outline-none text-[1.25rem] placeholder:text-ink-3"
        />
      </label>
      <div className="grid grid-cols-4 gap-1.5 mt-2">
        {[25, 50, 75, 100].map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={!typed && pct === v}
            onClick={() => {
              setPct(v);
              setUsd("");
            }}
            className={"h-10 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (!typed && pct === v ? "border-danger text-danger" : "border-line")}
          >
            {v === 100 ? "All" : `${v}%`}
          </button>
        ))}
      </div>
      {heldTokens !== null && (
        <p className="text-[0.75rem] text-ink-3 mt-2">
          {heldTokens > 0
            ? `You hold ${fmtTokens(heldTokens)} $${symbol}${worth !== null ? ` (about $${worth.toFixed(2)})` : ""}`
            : `You hold no $${symbol}`}
          {typed > 0 && worth !== null && typed > worth ? " · that's more than you hold, so all of it is sold" : ""}
        </p>
      )}
    </>
  );
}

const fmtTokens = (t: number) =>
  t >= 1e9 ? `${(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `${(t / 1e6).toFixed(2)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(1)}K` : t >= 1 ? t.toFixed(2) : String(Number(t.toPrecision(3)));

/** Raw coins to sell: the typed dollars at today's price (never more than held), else the % of what's held. */
export function sellRaw(held: bigint | null, decimals: number, usd: string, pct: number, priceUsd: number | null): bigint {
  if (held === null || held <= 0n) return 0n;
  const typed = Number(usd.replace(",", ".")) || 0;
  if (typed > 0) {
    if (!priceUsd || priceUsd <= 0) return 0n;
    const want = BigInt(Math.floor((typed / priceUsd) * 10 ** Math.min(decimals, 18)));
    return want > held ? held : want;
  }
  return (held * BigInt(pct)) / 100n;
}
