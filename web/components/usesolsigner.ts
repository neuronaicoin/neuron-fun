"use client";

/**
 * The user's Solana wallet, whichever kind: an email account's own Solana wallet (made the
 * first time it's needed), or the browser wallet's Solana account (MetaMask, Phantom & co.).
 */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet";
import type { SolSigner } from "@/lib/sollaunch";
import { rememberSolWallet } from "@/lib/solheld";

export function useSolSigner() {
  const w = useWallet();
  const [ext, setExt] = useState<{ name: string; address: string } | null>(null);

  // a Solana wallet that already trusts sasa connects without asking
  useEffect(() => {
    if (w.embedded || !w.address || ext) return;
    let alive = true;
    void import("@/lib/solwallet").then(async ({ solanaWallet }) => {
      const found = solanaWallet();
      if (!found) return;
      try {
        const address = await found.connect(true);
        if (alive && address) setExt({ name: found.name, address });
      } catch {
        /* not trusted yet: it asks when the user acts */
      }
    });
    return () => {
      alive = false;
    };
  }, [w.embedded, w.address, ext]);

  /** The Solana address, once known (an email account's wallet may not be made yet). */
  const address = w.embedded ? (w.solana?.address ?? null) : (ext?.address ?? null);
  // the balance shows this wallet's Solana coins from now on (lib/solheld.ts)
  useEffect(() => {
    if (w.address && address) rememberSolWallet(w.address, address);
  }, [w.address, address]);

  const get = useCallback(async (): Promise<SolSigner> => {
    if (w.embedded) {
      if (!w.solana) throw new Error("Your account is still loading. Try again in a moment.");
      const a = await w.solana.create();
      return { address: a, sign: w.solana.sign };
    }
    const { connectSolanaWallet, signWithSolanaWallet } = await import("@/lib/solwallet");
    // always the account the wallet has open now (the user may have switched)
    const c = await connectSolanaWallet();
    if (c.address !== ext?.address) setExt(c);
    return { address: c.address, sign: signWithSolanaWallet };
  }, [w.embedded, w.solana, ext]);

  return { address, walletName: w.embedded ? "Your Solana wallet" : (ext?.name ?? null), get };
}
