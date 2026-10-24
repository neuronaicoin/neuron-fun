"use client";

/**
 * The email account's own Solana wallet (Privy), for Solana launches. Loaded only for people who
 * see Solana (lib/solana.ts solanaFor), inside the login code (components/privy-bridge.tsx).
 * The wallet is made the first time it's needed, not at login.
 */
import { useEffect, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignTransaction, useWallets, type ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";

export type PrivySolState = {
  /** The Solana wallet's address, or null until it's made. */
  address: string | null;
  /** Makes the Solana wallet if there's none yet; returns its address. */
  create: () => Promise<string>;
  /** Signs a serialized Solana transaction (no popup). */
  sign: (tx: Uint8Array) => Promise<Uint8Array>;
};

type Linked = { type?: string; chainType?: string; walletClientType?: string; address?: string };

export default function PrivySol({ onState }: { onState: (s: PrivySolState | null) => void }) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const linked = ((user?.linkedAccounts ?? []) as Linked[]).find((a) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy");
  const address = linked?.address ?? null;

  // the latest values, for the functions handed out below
  const live = useRef({ wallets, address, createWallet, signTransaction });
  live.current = { wallets, address, createWallet, signTransaction };
  // the address of a wallet made just now (the user record catches up a moment later)
  const made = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated) {
      onState(null);
      return;
    }
    const walletFor = async (addr: string): Promise<ConnectedStandardSolanaWallet> => {
      // a wallet made a moment ago shows up in the list a little later
      for (let i = 0; i < 40; i++) {
        const w = live.current.wallets.find((x) => x.address === addr);
        if (w) return w;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("Your Solana wallet isn't ready yet. Try again in a moment.");
    };
    onState({
      address,
      create: async () => {
        if (live.current.address) return live.current.address;
        try {
          const { wallet } = await live.current.createWallet();
          made.current = wallet.address;
          return wallet.address;
        } catch (e) {
          // made meanwhile (another tab): use it
          if (live.current.address) return live.current.address;
          throw new Error(`Couldn't open your Solana wallet: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      },
      sign: async (tx) => {
        const addr = live.current.address ?? made.current;
        if (!addr) throw new Error("No Solana wallet yet.");
        const wallet = await walletFor(addr);
        const { signedTransaction } = await live.current.signTransaction({ transaction: tx, wallet, chain: "solana:mainnet" });
        return signedTransaction;
      },
    });
    return () => onState(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, address]);

  return null;
}
