/**
 * Moving money out of a Solana wallet with Relay (only loaded when it's used: big libraries).
 *
 *   sendSolanaQuote   runs a Relay quote whose first step is on Solana (sell a Solana coin for
 *                     USDC on Base; SOL back to Cash): builds the transaction from Relay's
 *                     instructions, the user's Solana wallet signs, sasa's node sends it
 *   solTokenBalance   how much of a Solana coin a wallet holds (both token programs)
 *   solToCash         what's left in the Solana wallet as SOL → USDC in Cash
 */
import "./bufferpoly";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { getQuote, type Quote } from "./relay";
import { CHAINS } from "./config";
import { SOLANA_ID, SOL_NATIVE } from "./solana";
import { sendAndConfirm, signAll, solBalance, solConnection, type SolSigner } from "./sollaunch";

const BASE = CHAINS.find((c) => c.key === "base")!;

type SolIx = { keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; programId: string; data: string };
type SolStepData = { instructions?: SolIx[]; addressLookupTableAddresses?: string[] };

const hexBytes = (h: string) => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("Relay sent a step we can't read.");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Runs every Solana step of `q` from `signer`'s wallet; returns the last transaction's id. */
export async function sendSolanaQuote(q: Quote, signer: SolSigner, onStep?: (m: string) => void): Promise<string> {
  const c = solConnection();
  let last = "";
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw new Error("This route needs a step we don't support yet. Try another amount.");
    for (const item of step.items) {
      if (item.status === "complete") continue;
      const d = item.data as unknown as SolStepData & { chainId?: number };
      if (d.chainId !== undefined && Number(d.chainId) !== SOLANA_ID) throw new Error("This route changed. Try again in a moment.");
      const ixs = (d.instructions ?? []).map(
        (ix) =>
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable })),
            data: Buffer.from(hexBytes(ix.data)),
          })
      );
      if (!ixs.length) throw new Error("Relay sent an empty step. Try again.");
      const alts = (
        await Promise.all((d.addressLookupTableAddresses ?? []).map((a) => c.getAddressLookupTable(new PublicKey(a)).then((r) => r.value)))
      ).filter((x): x is AddressLookupTableAccount => !!x);
      const bh = await c.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: new PublicKey(signer.address), recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(alts);
      onStep?.("Confirm in your wallet…");
      const signed = await signAll(new VersionedTransaction(msg), signer, []);
      onStep?.("Sending…");
      last = await sendAndConfirm(signed, bh.lastValidBlockHeight, onStep);
    }
  }
  if (!last) throw new Error("Nothing to send. Try again.");
  return last;
}

/** Raw amount of `mint` that `owner` holds (summed over its token accounts). */
export async function solTokenBalance(owner: string, mint: string): Promise<bigint> {
  const r = await solConnection().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, "confirmed");
  let total = 0n;
  for (const a of r.value) {
    const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
    if (amt && /^\d+$/.test(amt)) total += BigInt(amt);
  }
  return total;
}

/** Kept in the Solana wallet for network fees (sells pay theirs in SOL). */
export const SOL_KEEP_LAMPORTS = 3_000_000n; // 0.003 SOL
/** Below this, moving SOL back isn't worth a route. */
const MIN_BACK = 10_000_000n; // 0.01 SOL

/** What the SOL beyond the fee reserve would bring in Cash, or null when it's too little to move. */
export async function quoteSolToCash(solAddress: string, evmAddress: string): Promise<Quote | null> {
  const bal = await solBalance(solAddress);
  const amount = bal - SOL_KEEP_LAMPORTS;
  if (amount < MIN_BACK) return null;
  return getQuote({
    user: solAddress,
    recipient: evmAddress,
    originChainId: SOLANA_ID,
    originCurrency: SOL_NATIVE,
    destinationChainId: BASE.chain.id,
    destinationCurrency: BASE.usdc,
    amount: amount.toString(),
  });
}

/** Moves the SOL beyond the fee reserve back to Cash (USDC on Base). */
export async function solToCash(signer: SolSigner, evmAddress: string, onStep?: (m: string) => void): Promise<Quote | null> {
  const q = await quoteSolToCash(signer.address, evmAddress);
  if (!q) return null;
  await sendSolanaQuote(q, signer, onStep);
  return q;
}
