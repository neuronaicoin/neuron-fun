/**
 * Copying whales (web/edge/copy-api.js; the indexer places the orders, indexer/copytrade.mjs).
 * The user approves sasa's copy key once on Hyperliquid (it trades, never withdraws); then each
 * trader they copy is a row with their own amount, leverage cap and stop.
 */
import { authedDelete, authedGet, authedPost, type SignFn } from "./alerts";

export type CopySettings = { whale: string; per_trade: number; max_lev: number; copy_closes: boolean; stop_loss: number | null; active: boolean; paused_why: string | null };

export async function myCopies(sign: SignFn): Promise<{ copies: CopySettings[]; agent: string | null }> {
  const r = await authedGet<{ copies: CopySettings[]; agent: string | null }>(sign, "copy");
  return { copies: (r.copies ?? []).map((c) => ({ ...c, per_trade: Number(c.per_trade), max_lev: Number(c.max_lev), stop_loss: c.stop_loss === null ? null : Number(c.stop_loss) })), agent: r.agent };
}
/** The user's copy key address (made on first use). */
export async function copyAgent(sign: SignFn): Promise<string> {
  return (await authedPost<{ agent: string }>(sign, "copy/agent", {})).agent;
}
export async function startCopy(sign: SignFn, s: Omit<CopySettings, "active" | "paused_why">): Promise<void> {
  await authedPost(sign, "copy", { ...s, whale: s.whale.toLowerCase() });
}
export async function stopCopy(sign: SignFn, whale: string): Promise<void> {
  await authedDelete(sign, `copy/${whale.toLowerCase()}`);
}
