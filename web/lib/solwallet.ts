/**
 * Outside Solana wallets, for people who use sasa with a browser wallet instead of an email
 * account. Two kinds are found:
 *
 *   - wallets that put a Solana provider on the page (Phantom, Solflare, Backpack…)
 *   - wallets that register through the Solana "wallet standard" (MetaMask's Solana accounts,
 *     and most newer wallets)
 *
 * We only ask them to connect and to sign; they keep the keys.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

type Provider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString(): string } } | void>;
  signTransaction: <T>(tx: T) => Promise<T>;
};
type Win = { phantom?: { solana?: Provider }; solflare?: Provider; backpack?: Provider; solana?: Provider };

/** One outside Solana wallet, whichever kind. */
export type SolWallet = {
  name: string;
  /** Connects (asks the user, unless `quiet`: then only a wallet that already trusts sasa answers). */
  connect: (quiet?: boolean) => Promise<string | null>;
  /** Signs a serialized transaction with the connected account. */
  sign: (bytes: Uint8Array) => Promise<Uint8Array>;
};

const CHAIN = "solana:mainnet";

function injected(): SolWallet | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Win;
  const found: [string, Provider] | null = w.phantom?.solana?.isPhantom
    ? ["Phantom", w.phantom.solana]
    : w.solflare?.isSolflare
      ? ["Solflare", w.solflare]
      : w.backpack
        ? ["Backpack", w.backpack]
        : w.solana && typeof w.solana.signTransaction === "function"
          ? ["Solana wallet", w.solana]
          : null;
  if (!found) return null;
  const [name, p] = found;
  return {
    name,
    connect: async (quiet) => {
      const r = await p.connect(quiet ? { onlyIfTrusted: true } : undefined);
      const key = (r && "publicKey" in r && r.publicKey) || p.publicKey;
      return key ? key.toString() : null;
    },
    sign: async (bytes) => {
      await import("./bufferpoly");
      const { VersionedTransaction } = await import("@solana/web3.js");
      const signed = await p.signTransaction(VersionedTransaction.deserialize(bytes));
      return signed.serialize();
    },
  };
}

type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> };
type SignFeature = {
  signTransaction: (...inputs: { transaction: Uint8Array; account: WalletAccount; chain?: string }[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};

function standard(): SolWallet | null {
  if (typeof window === "undefined") return null;
  let list: readonly Wallet[] = [];
  try {
    list = getWallets().get();
  } catch {
    return null;
  }
  const w = list.find(
    (x) => x.chains.some((c) => c === CHAIN) && "standard:connect" in x.features && "solana:signTransaction" in x.features
  );
  if (!w) return null;
  let account: WalletAccount | null = null;
  const pick = (accounts: readonly WalletAccount[]) => accounts.find((a) => a.chains.some((c) => c === CHAIN)) ?? accounts[0] ?? null;
  return {
    name: w.name,
    connect: async (quiet) => {
      const f = w.features["standard:connect"] as ConnectFeature;
      const r = await f.connect(quiet ? { silent: true } : undefined);
      account = pick(r.accounts.length ? r.accounts : w.accounts);
      return account?.address ?? null;
    },
    sign: async (bytes) => {
      if (!account) {
        const f = w.features["standard:connect"] as ConnectFeature;
        account = pick((await f.connect()).accounts);
      }
      if (!account) throw new Error("The wallet didn't connect. Try again.");
      const f = w.features["solana:signTransaction"] as SignFeature;
      const [out] = await f.signTransaction({ transaction: bytes, account, chain: CHAIN });
      if (!out?.signedTransaction) throw new Error("The wallet didn't sign. Try again.");
      return out.signedTransaction;
    },
  };
}

let current: SolWallet | null = null;

/** The outside Solana wallet on this page, if any (Phantom-style first, then wallet-standard ones such as MetaMask). */
export function solanaWallet(): SolWallet | null {
  current = injected() ?? standard();
  return current;
}

/** Connects the outside Solana wallet and returns its address. */
export async function connectSolanaWallet(): Promise<{ name: string; address: string }> {
  const w = solanaWallet();
  if (!w) throw new Error("No Solana wallet found. Use MetaMask (it has Solana accounts) or Phantom, or log in with your email.");
  const address = await w.connect();
  if (!address) throw new Error("The wallet didn't connect. Try again.");
  return { name: w.name, address };
}

/** Signs a serialized transaction with the connected outside wallet. */
export async function signWithSolanaWallet(bytes: Uint8Array): Promise<Uint8Array> {
  const w = current ?? solanaWallet();
  if (!w) throw new Error("No Solana wallet found.");
  return w.sign(bytes);
}
