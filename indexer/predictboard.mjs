// GENERATED from web/lib/predict.ts (how Hyperliquid prediction markets read): keep the two the same.
// Regenerate after changing web/lib/predict.ts. Used by marketcards.mjs for share cards.

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
async function info(body, signal) {
    const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!r.ok)
        throw new Error("hyperliquid " + r.status);
    return r.json();
}
export const sideCoin = (outcome, side) => `#${10 * outcome + side}`;
/** "class:priceBinary|underlying:BTC|…" → { class: "priceBinary", underlying: "BTC", … } */
export function specOf(description) {
    const out = {};
    for (const part of (description ?? "").split("|")) {
        // "metadata=category:crypto" → category: crypto
        const [k, ...v] = part.replace(/^\s*metadata=/, "").split(":");
        if (k && v.length)
            out[k.trim()] = v.join(":").trim();
    }
    return out;
}
/** "20261024-0600" (UTC) → ms, or null. */
export function expiryMs(s) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s ?? "");
    if (!m)
        return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}
/** "today at 09:00", "tomorrow at 09:00", "Oct 26 at 09:00" (the visitor's own time). */
export function whenText(ms, now = Date.now()) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000);
    if (diff === 0)
        return `today at ${time}`;
    if (diff === 1)
        return `tomorrow at ${time}`;
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}
/** $82,000 / $3,000 / $0.52 */
export function priceText(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return String(v);
    if (n >= 1000)
        return `$${Math.round(n).toLocaleString("en-US")}`;
    return `$${Number(n.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}
const shortPrice = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n))
        return v;
    return n >= 1000 ? `$${Number((n / 1000).toPrecision(4))}K` : priceText(n);
};
const RATES = /\b(fed|fomc|ecb|boe|boj|rate|rates|cut|hike|cpi|inflation|interest|bps|central bank|payrolls|nfp|gdp|unemployment|treasury|yield)\b/i;
const SPORTS = /\b(vs\.?|v\.|match|game|nba|nfl|nhl|mlb|ufc|mma|f1|grand prix|league|cup|final|finals|champions|premier|playoff|series|tournament|open|fc|united|city|goals?|points|fighter|bout|race)\b/i;
export function tabOf(text) {
    if (RATES.test(text))
        return "rates";
    if (SPORTS.test(text))
        return "sports";
    return "other";
}
let templatesP = null;
export function fetchTemplates(signal) {
    if (!templatesP)
        templatesP = info({ type: "outcomeTemplates" }, signal)
            .then((rows) => new Map((Array.isArray(rows) ? rows : []).map((t) => [t.id, t])))
            .catch(() => {
            templatesP = null;
            return new Map();
        });
    return templatesP;
}
/** "policyRateNoChange" → "Policy rate no change" */
export function humanize(id) {
    const words = id
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim()
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : id;
}
const PRICE_KEYS = /^(threshold|target|low|high|price|strike|targetPrice|level)$/i;
const DATE_RE = /^\d{8}(-\d{4})?$/;
const FRIENDLY = {
    policyRateNoChange: "No change",
    policyRateDecrease: "Cut",
    policyRateIncrease: "Hike",
    Yes: "Yes",
    No: "No",
    Over: "Over",
    Under: "Under",
};
/** A keyword's value as people read it: dates in local time, prices with $ and commas. */
function valueText(key, v, type) {
    if (type === "dateTime" || type === "date" || DATE_RE.test(v)) {
        const ms = expiryMs(v.length === 8 ? `${v}-2359` : v);
        if (ms)
            return whenText(ms);
    }
    if (PRICE_KEYS.test(key) && Number.isFinite(Number(v)))
        return priceText(v);
    return v;
}
/** Fills a "template:…" string with the market's values; plain strings pass through. */
export function fillTemplate(s, spec, templates) {
    if (!s)
        return s;
    let t = s.startsWith("template:") ? s.slice("template:".length) : s;
    const tpl = templates.get(t);
    if (tpl)
        t = tpl.name;
    else if (FRIENDLY[t])
        t = FRIENDLY[t];
    else if (/^[a-z][A-Za-z0-9]*$/.test(t) && /[A-Z]/.test(t))
        t = humanize(t);
    const types = new Map((tpl?.keywords ?? []).map(([k, ty]) => [k, ty]));
    t = t.replace(/\{(\w+)\}/g, (_, k) => (spec[k] !== undefined ? valueText(k, spec[k], types.get(k)) : humanize(k)));
    return t.replace(/\s+/g, " ").trim();
}
/** The settle time from any date the market carries ("time", "expiry", or any date value). */
function expiryOf(spec) {
    for (const k of ["time", "expiry", "settleTime", "endTime", "date"])
        if (spec[k]) {
            const ms = expiryMs(spec[k].length === 8 ? `${spec[k]}-2359` : spec[k]);
            if (ms)
                return ms;
        }
    for (const v of Object.values(spec))
        if (DATE_RE.test(v)) {
            const ms = expiryMs(v.length === 8 ? `${v}-2359` : v);
            if (ms)
                return ms;
        }
    return null;
}
/** Which tab a template-made market goes under. */
function tabOfTemplate(id, spec) {
    const cat = `${spec.category ?? ""} ${spec.subCategory ?? ""}`.toLowerCase();
    if (/sport/.test(cat) || /^sports/i.test(id))
        return "sports";
    if (/macro|rate|econom/.test(cat) || /policyRate|rate|cpi|inflation/i.test(id))
        return "rates";
    if (/crypto|price/.test(cat) || /price|touch|scalar/i.test(id))
        return "price";
    return null;
}
/** Reads the open outcome markets and their prices. */
export async function fetchPredict(signal) {
    const [meta, mids, templates] = await Promise.all([
        info({ type: "outcomeMeta" }, signal),
        info({ type: "allMids" }, signal).catch(() => ({})),
        fetchTemplates(signal),
    ]);
    return boardOf(meta, mids, templates);
}
/** The board from Hyperliquid's answers (exported for tests). */
export function boardOf(meta, mids, templates = new Map()) {
    const outcomes = (Array.isArray(meta?.outcomes) ? meta.outcomes : []).filter((o) => o && Number.isInteger(o.outcome));
    const questions = (Array.isArray(meta?.questions) ? meta.questions : []).filter((q) => q && Array.isArray(q.namedOutcomes));
    const fallback = new Set(questions.map((q) => q.fallbackOutcome));
    const ownerOf = new Map();
    for (const q of questions)
        for (const o of q.namedOutcomes ?? [])
            ownerOf.set(o, q);
    const mid = (coin) => {
        const v = Number(mids?.[coin]);
        return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
    };
    const sideOf = (o, i, spec) => {
        const enc = 10 * o.outcome + i;
        const name = fillTemplate(o.sideSpecs?.[i]?.name || "", spec, templates) || (i === 0 ? "Yes" : "No");
        return { name, coin: `#${enc}`, token: `+${enc}`, asset: 100_000_000 + enc, price: mid(`#${enc}`) };
    };
    const made = new Map();
    for (const o of outcomes) {
        if (fallback.has(o.outcome) || (o.sideSpecs?.length ?? 0) < 2)
            continue;
        const q = ownerOf.get(o.outcome);
        const spec = specOf(o.description);
        const qspec = specOf(q?.description ?? "");
        let tab;
        let title;
        let label = o.name;
        let expiry = null;
        if (spec.class === "priceBinary" && spec.underlying && spec.targetPrice) {
            expiry = expiryMs(spec.expiry);
            tab = "price";
            title = `${spec.underlying} above ${priceText(spec.targetPrice)}${expiry ? ` ${whenText(expiry)}` : ""}?`;
            label = "";
        }
        else if (qspec.class === "priceBucket" && qspec.underlying) {
            expiry = expiryMs(qspec.expiry);
            tab = "price";
            const [a, b] = (qspec.priceThresholds ?? "").split(",");
            const i = q.namedOutcomes.indexOf(o.outcome);
            label = a && b ? (i === 0 ? `Below ${shortPrice(a)}` : i === 1 ? `${shortPrice(a)} – ${shortPrice(b)}` : `Above ${shortPrice(b)}`) : o.name;
            title = `${qspec.underlying} price ${expiry ? whenText(expiry) : ""}`.trim();
        }
        else if (o.name.startsWith("template:") || (q?.name ?? "").startsWith("template:")) {
            // a market made from a template: its values fill the template's words
            const id = o.name.startsWith("template:") ? o.name.slice(9) : "";
            const qid = (q?.name ?? "").startsWith("template:") ? q.name.slice(9) : "";
            const all = { ...qspec, ...spec };
            expiry = expiryOf(spec) ?? expiryOf(qspec);
            tab = tabOfTemplate(id || qid, all) ?? tabOfTemplate(qid, all) ?? "other";
            const perp = all.perp ?? all.underlying ?? all.coin;
            if (id === "binaryPrice" && perp && (all.threshold ?? all.targetPrice)) {
                title = `${perp} above ${priceText(all.threshold ?? all.targetPrice)}${expiry ? ` ${whenText(expiry)}` : ""}?`;
                label = "";
            }
            else if (id === "priceTouch" && perp && (all.target ?? all.threshold)) {
                title = `${perp} touches ${priceText(all.target ?? all.threshold)}${expiry ? ` by ${whenText(expiry)}` : ""}?`;
                label = "";
            }
            else if (id === "scalarPrice" && perp && all.low && all.high) {
                title = `${perp} between ${priceText(all.low)} and ${priceText(all.high)}${expiry ? ` ${whenText(expiry)}` : ""}?`;
                label = "";
            }
            else {
                const filled = fillTemplate(o.name, all, templates);
                label = filled;
                const qTitle = q && q.namedOutcomes.length > 1 ? fillTemplate(q.name, all, templates) : "";
                title = qTitle || (filled.endsWith("?") ? filled : / vs\.? /i.test(filled) ? `${filled}: who wins?` : `${filled}?`);
            }
        }
        else {
            expiry = expiryMs(spec.expiry) ?? expiryMs(qspec.expiry);
            const text = `${q?.name ?? ""} ${o.name} ${o.description} ${q?.description ?? ""}`;
            tab = tabOf(text);
            title = q && q.namedOutcomes.length > 1 ? q.name : o.name.endsWith("?") ? o.name : `${o.name}?`;
        }
        const quote = String(o.quoteToken ?? "");
        const all = { ...qspec, ...spec };
        const tagOf = () => {
            const perp = all.perp ?? all.underlying ?? all.coin;
            if (perp)
                return String(perp).replace(/^[a-z0-9]+:/i, "");
            if (tab === "sports")
                return fillTemplate(o.sideSpecs?.[0]?.name ?? "", all, templates);
            if (all.institution)
                return all.institution;
            return title.split(/\s+/)[0] ?? "";
        };
        made.set(o.outcome, {
            tag: tagOf(),
            outcome: o.outcome,
            tab,
            title,
            label,
            expiry,
            sides: [sideOf(o, 0, all), sideOf(o, 1, all)],
            quote,
            tradable: /usdc/i.test(quote) || quote === "" || quote === "0",
            raw: `${q ? `Q ${q.name} | ${q.description} || ` : ""}${o.name} | ${o.description} | sides: ${(o.sideSpecs ?? []).map((x) => x.name).join(", ")} | quote: ${quote}`,
        });
    }
    const groups = [];
    const grouped = new Set();
    for (const q of questions) {
        const answers = (q.namedOutcomes ?? []).filter((o) => !(q.settledNamedOutcomes ?? []).includes(o)).map((o) => made.get(o)).filter((x) => !!x);
        if (answers.length < 2)
            continue;
        answers.forEach((a) => grouped.add(a.outcome));
        const qspec = specOf(q.description);
        groups.push({
            question: q.question,
            tab: answers[0].tab,
            title: qspec.class === "priceBucket" ? `${answers[0].title}: which range?` : fillTemplate(q.name, qspec, templates),
            expiry: answers[0].expiry,
            answers,
        });
    }
    const singles = [...made.values()].filter((o) => !grouped.has(o.outcome));
    const soon = (x) => x.expiry ?? Number.MAX_SAFE_INTEGER;
    singles.sort((a, b) => soon(a) - soon(b));
    groups.sort((a, b) => soon(a) - soon(b));
    return { singles, groups };
}
/** USDC and outcome shares in the user's spot account. */
export async function fetchPredictWallet(user, signal) {
    const s = await info({ type: "spotClearinghouseState", user: user.toLowerCase() }, signal);
    let cash = 0;
    const holdings = [];
    for (const b of s?.balances ?? []) {
        const total = Number(b.total) || 0;
        if (b.coin === "USDC")
            cash = Math.max(0, total - (Number(b.hold) || 0));
        const m = /^\+(\d+)$/.exec(b.coin);
        if (m && total > 0) {
            const enc = Number(m[1]);
            holdings.push({ token: b.coin, outcome: Math.floor(enc / 10), side: (enc % 10), shares: total, cost: Number(b.entryNtl) || 0 });
        }
    }
    return { cash, holdings };
}
/** Best bid and ask of one side (0–1), straight from its book. */
export async function bestOf(coin) {
    const r = await info({ type: "l2Book", coin });
    const bid = Number(r?.levels?.[0]?.[0]?.px);
    const ask = Number(r?.levels?.[1]?.[0]?.px);
    return { bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null };
}
/** Smallest order Hyperliquid takes, in dollars. */
export const PREDICT_MIN = 10;
/** sasa's fee on a prediction (Hyperliquid builder fee, tenths of a basis point: 500 = 0.5%). */
export const PREDICT_FEE_TENTHS_BP = 500;
