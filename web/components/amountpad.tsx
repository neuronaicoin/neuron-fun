"use client";

/**
 * Phones: the buy amount as a big number with a keypad under it, like a payments app.
 * No keyboard pops up and covers the sheet; quick amounts sit right above the keys.
 */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"] as const;

export function AmountPad({
  value,
  onChange,
  presets = [10, 25, 50, 100],
}: {
  value: string;
  onChange: (v: string) => void;
  presets?: number[];
}) {
  const amount = Number(value) || 0;
  function press(k: (typeof KEYS)[number]) {
    if (k === "del") return onChange(value.slice(0, -1));
    if (k === ".") {
      if (value.includes(".")) return;
      return onChange((value || "0") + ".");
    }
    // at most 2 decimals, and no number past $1M
    const i = value.indexOf(".");
    if (i >= 0 && value.length - i > 2) return;
    const next = value === "0" ? k : value + k;
    if (Number(next) > 1_000_000) return;
    onChange(next);
  }
  const shown = value === "" ? "0" : value;
  const len = shown.length;
  return (
    <div className="select-none">
      <div className="pt-6 pb-5 text-center" aria-live="polite">
        <span
          className={
            "font-display font-extrabold tabular-nums tracking-tight leading-none " +
            (amount > 0 ? "text-ink" : "text-ink-3") +
            (len > 8 ? " text-[2.5rem]" : len > 6 ? " text-[3rem]" : " text-[3.75rem]")
          }
        >
          ${shown}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {presets.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={amount === v}
            onClick={() => onChange(String(v))}
            className={"h-11 rounded-xl font-bold text-[0.9375rem] active:scale-[0.96] transition-transform " + (amount === v ? "bg-emerald-soft text-emerald" : "bg-paper text-ink")}
          >
            ${v}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 mt-2" role="group" aria-label="Amount keypad">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === "del" ? "Delete" : k}
            className="h-14 rounded-2xl text-[1.625rem] font-semibold text-ink active:bg-paper grid place-items-center"
          >
            {k === "del" ? (
              <svg width="28" height="22" viewBox="0 0 28 22" fill="none" aria-hidden="true">
                <path d="M9 1h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9L1 11 9 1Z" fill="currentColor" />
                <path d="M13 7l8 8M21 7l-8 8" stroke="var(--color-paper, #fff)" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            ) : (
              k
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
