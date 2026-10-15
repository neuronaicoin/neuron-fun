"use client";

/**
 * Email / Google login. Loaded after the page is up (see wallet.tsx), so the
 * login code never slows down the first paint. It reports the signed-in
 * user's embedded wallet back to WalletProvider and nothing else.
 */
import { useEffect, useRef } from "react";
import type { LocalAccount } from "viem";
import { PrivyProvider, toViemAccount, usePrivy, useSign7702Authorization, useWallets } from "@privy-io/react-auth";
import type { SignAuthorization } from "@/lib/usdcgas";
import { CHAINS, PRIVY_APP_ID } from "@/lib/config";
import { RACE_CHAINS } from "@/lib/race";
import { usdcGasChain } from "@/lib/usdcgas";
import { base, baseSepolia, mainnet } from "viem/chains";

export type PrivyState = {
  ready: boolean;
  authenticated: boolean;
  address: `0x${string}` | null;
  signer: LocalAccount | null;
  /** EIP-7702 authorization by the embedded wallet (network fees in USDC, lib/usdcgas.ts). */
  signAuthorization: SignAuthorization | null;
  email: string | null;
  /**
   * Sends one plain transaction from the embedded wallet on `chainId`, gas paid by the user in
   * that chain's own coin (race chains other than Base: the gas comes from their top-up).
   */
  sendTransaction: ((chainId: number, tx: { to: `0x${string}`; data: `0x${string}`; value?: bigint; gas?: bigint }) => Promise<`0x${string}`>) | null;
  login: () => void;
  logout: () => Promise<void>;
};

const SUPPORTED = [
  ...CHAINS.map((c) => c.chain),
  ...RACE_CHAINS.map((c) => c.chain),
  ...[base, baseSepolia].filter((c) => usdcGasChain(c.id) && (c.testnet ?? false) === (CHAINS[0].chain.testnet ?? false)),
  // mainnet: Ethereum too (Market coins live there; the account pays its own gas)
  ...(CHAINS[0].chain.testnet ? [] : [mainnet]),
].filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);

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
          // Outside wallets connect through sasa's own Connect button, not Privy. Leaving
          // Coinbase off this list stops Privy loading the Coinbase SDK, whose page check
          // printed a warning in the browser console on every visit.
          walletList: ["metamask"],
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Trades are confirmed in sasa's own trade box; no second wallet popup.
          showWalletUIs: false,
        },
        defaultChain: CHAINS[0].chain,
        // Every chain sasa sends on (site chains, race chains, and Base for USDC deposits and
        // withdrawals). A chain missing here makes email-account transactions hang forever.
        supportedChains: SUPPORTED,
      }}
    >
      <Reporter onState={onState} loginRequests={loginRequests} />
    </PrivyProvider>
  );
}

function Reporter({ onState, loginRequests }: { onState: (s: PrivyState) => void; loginRequests: number }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();
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
        signAuthorization:
          authenticated && embedded
            ? async (a) => {
                const s = await signAuthorization(a, { address: embedded.address });
                return { ...s, address: s.address, chainId: s.chainId, nonce: s.nonce } as never;
              }
            : null,
        email: user?.email?.address ?? user?.google?.email ?? null,
        sendTransaction:
          authenticated && embedded
            ? async (chainId, tx) => {
                await embedded.switchChain(chainId);
                const provider = await embedded.getEthereumProvider();
                const hex = (v: bigint) => `0x${v.toString(16)}`;
                return (await provider.request({
                  method: "eth_sendTransaction",
                  params: [{ from: embedded.address, to: tx.to, data: tx.data, value: hex(tx.value ?? 0n), ...(tx.gas ? { gas: hex(tx.gas) } : {}) }],
                })) as `0x${string}`;
              }
            : null,
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
