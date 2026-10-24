/**
 * Outside Solana wallets (Phantom, Solflare, Backpack and the like), for people who use sasa with
 * a browser wallet instead of an email account. They add themselves to the page; we only ask
 * them to connect and to sign.
 */

type Provider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString(): string } } | void>;
  signTransaction: <T>(tx: T) => Promise<T>;
};

type Win = { phantom?: { solana?: Provider }; solflare?: Provider; backpack?: Provider; solana?: Provider };

export function solanaProvider(): { name: string; p: Provider } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Win;
  if (w.phantom?.solana?.isPhantom) return { name: "Phantom", p: w.phantom.solana };
  if (w.solflare?.isSolflare) return { name: "Solflare", p: w.solflare };
  if (w.backpack) return { name: "Backpack", p: w.backpack };
  if (w.solana && typeof w.solana.signTransaction === "function") return { name: "Solana wallet", p: w.solana };
  return null;
}

/** Connects the outside Solana wallet and returns its address. */
export async function connectSolanaWallet(): Promise<{ name: string; address: string }> {
  const found = solanaProvider();
  if (!found) throw new Error("No Solana wallet found. Open sasa in Phantom's browser, or install Phantom.");
  const r = await found.p.connect();
  const key = (r && "publicKey" in r && r.publicKey) || found.p.publicKey;
  if (!key) throw new Error("The wallet didn't connect. Try again.");
  return { name: found.name, address: key.toString() };
}

/** Signs a serialized transaction with the outside wallet. */
export async function signWithSolanaWallet(bytes: Uint8Array): Promise<Uint8Array> {
  const found = solanaProvider();
  if (!found) throw new Error("No Solana wallet found.");
  await import("./bufferpoly");
  const { VersionedTransaction } = await import("@solana/web3.js");
  const signed = await found.p.signTransaction(VersionedTransaction.deserialize(bytes));
  return signed.serialize();
}
