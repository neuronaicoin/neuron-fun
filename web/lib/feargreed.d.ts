export type FgParts = { breadth: number; bitcoin: number; momentum: number; funding: number };
export type FearGreed = { score: number; label: string; parts: FgParts; upShare: number; avgMove: number; fundingYear: number; btcMove: number | null };
export const FG_WEIGHTS: FgParts;
export function fearGreed(markets: { coin: string; change24h: number | null; volume24h: number; funding: number }[]): FearGreed | null;
export function fgLabel(score: number): string;
