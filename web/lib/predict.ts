/**
 * Predict: Hyperliquid's outcome markets (HIP-4), read from its free public API.
 *
 * An outcome is a yes/no contract that pays $1 a share if it comes true, $0 if not. Each side
 * trades on its own order book: side 0 (usually "Yes") and side 1 (usually "No").
 *   - book / order coin: `#<10 × outcome + side>`
 *   - balance name:      `+<10 × outcome + side>` (in the spot account)
 *   - order asset id:    100000000 + 10 × outcome + side
 * Recurring price markets describe themselves as `class:priceBinary|underlying:BTC|expiry:YYYYMMDD-HHMM|targetPrice:…`
 * (or `class:priceBucket|…|priceThresholds:a,b` on a question with three outcomes: below, between, above).
 */
import { info } from "./perps";

export type PredictTab = "price" | "sports" | "rates" | "other";

export type PredictSide = {
  name: string;
  /** "#10" */
  coin: string;
  /** "+10" */
  token: string;
  asset: number;
  /** Mid price, 0–1 (the market's chance); null when the book is empty. */
  price: number | null;
};

export type PredictOutcome = {
  outcome: number;
  tab: PredictTab;
  /** The question as people read it: "BTC above $82,000 tomorrow at 09:00?" */
  title: string;
  /** For a row inside a multi-answer card: "$78K – $82K", "Team A". */
  label: string;
  /** When it settles (ms), when known. */
  expiry: number | null;
  sides: [PredictSide, PredictSide];
  /** The money it trades in ("USDC"); only USDC markets can be bought here. */
  quote: string;
  tradable: boolean;
};

/** A question with several answers (a price range, a match winner): one row per answer. */
export type PredictGroup = {
  question: number;
  tab: PredictTab;
  title: string;
  expiry: number | null;
  answers: PredictOutcome[];
};

export type PredictBoard = { singles: PredictOutcome[]; groups: PredictGroup[] };

type Meta = {
  outcomes: { outcome: number; name: string; description: string; sideSpecs: { name: string }[]; quoteToken: string }[];
  questions: { question: number; name: string; description: string; fallbackOutcome: number; namedOutcomes: number[]; settledNamedOutcomes: number[] }[];
};

export const sideCoin = (outcome: number, side: 0 | 1) => `#${10 * outcome + side}`;

/** "class:priceBinary|underlying:BTC|…" → { class: "priceBinary", underlying: "BTC", … } */
export function specOf(description: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (description ?? "").split("|")) {
    const [k, ...v] = part.split(":");
    if (k && v.length) out[k.trim()] = v.join(":").trim();
  }
  return out;
}

/** "20261024-0600" (UTC) → ms, or null. */
export function expiryMs(s: string | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** "today at 09:00", "tomorrow at 09:00", "Oct 26 at 09:00" (the visitor's own time). */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}

/** $82,000 / $3,000 / $0.52 */
export function priceText(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${Number(n.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}
const shortPrice = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n >= 1000 ? `$${Number((n / 1000).toPrecision(4))}K` : priceText(n);
};

const RATES = /\b(fed|fomc|ecb|boe|boj|rate|rates|cut|hike|cpi|inflation|interest|bps|central bank|payrolls|nfp|gdp|unemployment|treasury|yield)\b/i;
const SPORTS = /\b(vs\.?|v\.|match|game|nba|nfl|nhl|mlb|ufc|mma|f1|grand prix|league|cup|final|finals|champions|premier|playoff|series|tournament|open|fc|united|city|goals?|points|fighter|bout|race)\b/i;

export function tabOf(text: string): PredictTab {
  if (RATES.test(text)) return "rates";
  if (SPORTS.test(text)) return "sports";
  return "other";
}

/** Reads the open outcome markets and their prices. */
export async function fetchPredict(signal?: AbortSignal): Promise<PredictBoard> {
  const [meta, mids] = await Promise.all([info<Meta>({ type: "outcomeMeta" }, signal), info<Record<string, string>>({ type: "allMids" }, signal).catch(() => ({}) as Record<string, string>)]);
  return boardOf(meta, mids);
}

/** The board from Hyperliquid's answers (exported for tests). */
export function boardOf(meta: Meta, mids: Record<string, string>): PredictBoard {
  const outcomes = Array.isArray(meta?.outcomes) ? meta.outcomes : [];
  const questions = Array.isArray(meta?.questions) ? meta.questions : [];
  const fallback = new Set(questions.map((q) => q.fallbackOutcome));
  const ownerOf = new Map<number, Meta["questions"][number]>();
  for (const q of questions) for (const o of q.namedOutcomes ?? []) ownerOf.set(o, q);

  const mid = (coin: string) => {
    const v = Number(mids?.[coin]);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
  };
  const sideOf = (o: Meta["outcomes"][number], i: 0 | 1): PredictSide => {
    const enc = 10 * o.outcome + i;
    return { name: o.sideSpecs?.[i]?.name || (i === 0 ? "Yes" : "No"), coin: `#${enc}`, token: `+${enc}`, asset: 100_000_000 + enc, price: mid(`#${enc}`) };
  };

  const made = new Map<number, PredictOutcome>();
  for (const o of outcomes) {
    if (fallback.has(o.outcome) || (o.sideSpecs?.length ?? 0) < 2) continue;
    const q = ownerOf.get(o.outcome);
    const spec = specOf(o.description);
    const qspec = specOf(q?.description ?? "");
    let tab: PredictTab;
    let title: string;
    let label = o.name;
    let expiry: number | null = null;
    if (spec.class === "priceBinary" && spec.underlying && spec.targetPrice) {
      expiry = expiryMs(spec.expiry);
      tab = "price";
      title = `${spec.underlying} above ${priceText(spec.targetPrice)}${expiry ? ` ${whenText(expiry)}` : ""}?`;
      label = "";
    } else if (qspec.class === "priceBucket" && qspec.underlying) {
      expiry = expiryMs(qspec.expiry);
      tab = "price";
      const [a, b] = (qspec.priceThresholds ?? "").split(",");
      const i = q!.namedOutcomes.indexOf(o.outcome);
      label = a && b ? (i === 0 ? `Below ${shortPrice(a)}` : i === 1 ? `${shortPrice(a)} – ${shortPrice(b)}` : `Above ${shortPrice(b)}`) : o.name;
      title = `${qspec.underlying} price ${expiry ? whenText(expiry) : ""}`.trim();
    } else {
      expiry = expiryMs(spec.expiry) ?? expiryMs(qspec.expiry);
      const text = `${q?.name ?? ""} ${o.name} ${o.description} ${q?.description ?? ""}`;
      tab = tabOf(text);
      title = q && q.namedOutcomes.length > 1 ? q.name : o.name.endsWith("?") ? o.name : `${o.name}?`;
    }
    const quote = String(o.quoteToken ?? "");
    made.set(o.outcome, { outcome: o.outcome, tab, title, label, expiry, sides: [sideOf(o, 0), sideOf(o, 1)], quote, tradable: /usdc/i.test(quote) || quote === "" || quote === "0" });
  }

  const groups: PredictGroup[] = [];
  const grouped = new Set<number>();
  for (const q of questions) {
    const answers = (q.namedOutcomes ?? []).filter((o) => !(q.settledNamedOutcomes ?? []).includes(o)).map((o) => made.get(o)).filter((x): x is PredictOutcome => !!x);
    if (answers.length < 2) continue;
    answers.forEach((a) => grouped.add(a.outcome));
    const qspec = specOf(q.description);
    groups.push({
      question: q.question,
      tab: answers[0].tab,
      title: qspec.class === "priceBucket" ? `${answers[0].title}: which range?` : q.name,
      expiry: answers[0].expiry,
      answers,
    });
  }
  const singles = [...made.values()].filter((o) => !grouped.has(o.outcome));
  const soon = (x: { expiry: number | null }) => x.expiry ?? Number.MAX_SAFE_INTEGER;
  singles.sort((a, b) => soon(a) - soon(b));
  groups.sort((a, b) => soon(a) - soon(b));
  return { singles, groups };
}

// ------------------------------------------------------------------ the user's side

export type PredictHolding = { token: string; outcome: number; side: 0 | 1; shares: number; cost: number };
export type PredictWallet = { cash: number; holdings: PredictHolding[] };

/** USDC and outcome shares in the user's spot account. */
export async function fetchPredictWallet(user: string, signal?: AbortSignal): Promise<PredictWallet> {
  const s = await info<{ balances?: { coin: string; total: string; hold: string; entryNtl: string }[] }>({ type: "spotClearinghouseState", user: user.toLowerCase() }, signal);
  let cash = 0;
  const holdings: PredictHolding[] = [];
  for (const b of s?.balances ?? []) {
    const total = Number(b.total) || 0;
    if (b.coin === "USDC") cash = Math.max(0, total - (Number(b.hold) || 0));
    const m = /^\+(\d+)$/.exec(b.coin);
    if (m && total > 0) {
      const enc = Number(m[1]);
      holdings.push({ token: b.coin, outcome: Math.floor(enc / 10), side: (enc % 10) as 0 | 1, shares: total, cost: Number(b.entryNtl) || 0 });
    }
  }
  return { cash, holdings };
}

/** Best bid and ask of one side (0–1), straight from its book. */
export async function bestOf(coin: string): Promise<{ bid: number | null; ask: number | null }> {
  const r = await info<{ levels?: [{ px: string }[], { px: string }[]] }>({ type: "l2Book", coin });
  const bid = Number(r?.levels?.[0]?.[0]?.px);
  const ask = Number(r?.levels?.[1]?.[0]?.px);
  return { bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null };
}

/** Smallest order Hyperliquid takes, in dollars. */
export const PREDICT_MIN = 10;
/** sasa's fee on a prediction (Hyperliquid builder fee, tenths of a basis point: 500 = 0.5%). */
export const PREDICT_FEE_TENTHS_BP = 500;
