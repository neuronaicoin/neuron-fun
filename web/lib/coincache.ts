/**
 * What a list already knows about a coin (name, picture, market cap), kept for a few
 * minutes so the coin page can show its header the moment it opens, before its own
 * data arrives. In memory first, sessionStorage as a backup (a reload of the page).
 */
export type CoinPeek = {
  name: string;
  symbol: string;
  image: string | null;
  mc: number | null;
  /** 24h change in percent (12.5 = +12.5%). */
  change: number | null;
  where: string | null;
  at?: number;
};

const KEY = "sasa.peek";
const TTL = 10 * 60_000;
const mem = new Map<string, CoinPeek>();

/** Page paths are stored without query noise and with a trailing slash, like Next links. */
function norm(href: string): string {
  try {
    const u = new URL(href, "https://x.invalid");
    const path = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
    return path + (u.search || "");
  } catch {
    return href;
  }
}

function load(): Record<string, CoinPeek> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "{}") as Record<string, CoinPeek>;
  } catch {
    return {};
  }
}

export function rememberCoin(href: string, peek: CoinPeek): void {
  const k = norm(href);
  const v = { ...peek, at: Date.now() };
  mem.set(k, v);
  try {
    const all = load();
    all[k] = v;
    // keep the newest 40
    const keys = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
    for (const old of keys.slice(40)) delete all[old];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode: memory only */
  }
}

/** The peek for this page (path + query), if one was saved in the last few minutes. */
export function peekCoin(href: string): CoinPeek | null {
  const k = norm(href);
  const v = mem.get(k) ?? load()[k];
  if (!v || Date.now() - (v.at ?? 0) > TTL) return null;
  return v;
}
