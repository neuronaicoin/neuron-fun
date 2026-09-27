"use client";

/**
 * Email / Google login. Loaded after the page is up (see wallet.tsx), so the
 * login code never slows down the first paint. It reports the signed-in
 * user's embedded wallet back to WalletProvider and nothing else.
 */
import { useEffect, useRef } from "react";
import type { LocalAccount } from "viem";
import { PrivyProvider, toViemAccount, usePrivy, useWallets } from "@privy-io/react-auth";
import { CHAINS, PRIVY_APP_ID } from "@/lib/config";

export type PrivyState = {
  ready: boolean;
  authenticated: boolean;
  address: `0x${string}` | null;
  signer: LocalAccount | null;
  email: string | null;
  login: () => void;
  logout: () => Promise<void>;
};

export default function PrivyBridge({ onState, loginRequests }: { onState: (s: PrivyState) => void; loginRequests: number }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "twitter", "passkey"],
        appearance: {
          theme: "dark",
          accentColor: "#FF6B1A",
          logo: "/sasa-icon-192.png",
          landingHeader: "Log in to sasa",
          loginMessage: "No wallet needed. We create one for you.",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Trades are confirmed in sasa's own trade box; no second wallet popup.
          showWalletUIs: false,
        },
        defaultChain: CHAINS[0].chain,
        supportedChains: CHAINS.map((c) => c.chain),
      }}
    >
      <Reporter onState={onState} loginRequests={loginRequests} />
    </PrivyProvider>
  );
}

function Reporter({ onState, loginRequests }: { onState: (s: PrivyState) => void; loginRequests: number }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? null;
  const handled = useRef(0);

  // Open the login window when the site asks for it.
  useEffect(() => {
    if (ready && !authenticated && loginRequests > handled.current) {
      handled.current = loginRequests;
      login();
    }
  }, [ready, authenticated, loginRequests, login]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const signer = authenticated && embedded ? ((await toViemAccount({ wallet: embedded })) as LocalAccount) : null;
      if (!alive) return;
      onState({
        ready,
        authenticated,
        address: authenticated && embedded ? (embedded.address as `0x${string}`) : null,
        signer,
        email: user?.email?.address ?? user?.google?.email ?? null,
        login,
        logout,
      });
    })().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, embedded?.address, user?.id]);

  return null;
}
