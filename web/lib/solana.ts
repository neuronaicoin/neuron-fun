/**
 * Solana on sasa. Built in steps and switched on only when everything is in place:
 *
 *   SOLANA_OPEN = false   nobody sees it, except the team's own wallets (SOLANA_TEAM),
 *                         who use it to test with real money first
 *   SOLANA_OPEN = true    everyone
 *
 * Step 1 (this file + components/solanamoney.tsx): USDC in and out over Solana. The user's
 * Cash stays one USDC number: a Solana deposit goes through a one-time Relay address and lands
 * as USDC in the same account as every other deposit; a Solana withdrawal is a Relay route from
 * that USDC to any Solana address. No Solana wallet is needed for either.
 *
 * Step 2 (lib/sollaunch.ts + components/solanalaunch.tsx): a coin launched on Solana, on the
 * standard Solana launch curve, so it shows up at once in every Solana app (explorers,
 * DexScreener, GMGN, wallets). Half of the coin's creator fees go to sasa (SOLANA_TREASURY, set
 * on the server), half to the creator, fixed for good in the launch itself.
 */
import { SOLANA_ID } from "./relay";

export const SOLANA_OPEN = false;

/** The team's wallets: they see Solana before everyone (same as the futures geo exemption in lib/perps.ts). */
const SOLANA_TEAM = new Set(["0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b", "0xe0ba5905940d748b23dc01266aa884e2391cca2f", "0xf4bc1b22e117a621e1118d09f7bb015c685a9617"]);

export const solanaFor = (address?: string | null) => SOLANA_OPEN || (!!address && SOLANA_TEAM.has(address.toLowerCase()));

export { SOLANA_ID };
/** Circle's USDC on Solana. */
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_EXPLORER_TX = (sig: string) => `https://solscan.io/tx/${sig}`;

/** sasa's own path to a Solana node (functions/sol-rpc). */
export const SOL_RPC = "/sol-rpc";
/** Relay's id for SOL itself on Solana. */
export const SOL_NATIVE = "11111111111111111111111111111111";
export const LAMPORTS = 1_000_000_000;
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;
export const dexscreenerSol = (mint: string) => `https://dexscreener.com/solana/${mint}`;
export const gmgnSol = (mint: string) => `https://gmgn.ai/sol/token/${mint}`;
