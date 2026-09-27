"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, numberToHex, type Address, type Chain, type WalletClient } from "viem";
import dynamic from "next/dynamic";
import { createPublicClient, http, type Hex } from "viem";
import { ALCHEMY_KEY, CHAINS, WALLETCONNECT_PROJECT_ID } from "@/lib/config";
import type { Call } from "@/lib/tx";
import { clientFor } from "@/lib/data";
import type { PrivyState } from "./privy-bridge";
import type { SmartWalletClient } from "@alchemy/wallet-apis";

// Email / Google login: its code loads after the page is up, never before.
const PrivyBridge = dynamic(() => import("./privy-bridge"), { ssr: false });

export type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, fn: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...a: unknown[]) => void) => void;
};

/** A wallet found in this browser (EIP-6963), the legacy window.ethereum, or WalletConnect. */
export type WalletOption = {
  id: string;
  name: string;
  icon: string;
  provider?: Eip1193;
  /** Built on demand (WalletConnect loads its code only when chosen). */
  lazy?: () => Promise<Eip1193>;
};

type WcProvider = Eip1193 & { session?: unknown; connect: () => Promise<void>; disconnect: () => Promise<void> };

export const WALLETCONNECT_ID = "walletconnect";
const WC_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#3B99FC"/><path d="M12.2 15.3c4.3-4.2 11.3-4.2 15.6 0l.5.5a.5.5 0 0 1 0 .8l-1.8 1.7a.3.3 0 0 1-.4 0l-.7-.7a8.2 8.2 0 0 0-11.4 0l-.8.7a.3.3 0 0 1-.4 0L11 16.6a.5.5 0 0 1 0-.8zm19.3 3.6 1.6 1.6a.5.5 0 0 1 0 .8l-7.1 7a.6.6 0 0 1-.8 0l-5-5a.1.1 0 0 0-.2 0l-5 5a.6.6 0 0 1-.8 0l-7.2-7a.5.5 0 0 1 0-.8l1.6-1.6a.6.6 0 0 1 .8 0l5 5c.1 0 .2 0 .2 0l5-5a.6.6 0 0 1 .8 0l5 5h.2l5-5a.6.6 0 0 1 .9 0z" fill="#fff"/></svg>'
  );

let wcPromise: Promise<WcProvider> | null = null;
/** One shared WalletConnect provider; its code is only downloaded when first needed. */
function walletConnect(): Promise<WcProvider> {
  if (!wcPromise) {
    wcPromise = (async () => {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const ids = CHAINS.map((c) => c.chain.id);
      const p = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        optionalChains: ids as [number, ...number[]],
        rpcMap: Object.fromEntries(CHAINS.map((c) => [c.chain.id, c.chain.rpcUrls.default.http[0]])),
        showQrModal: true,
        qrModalOptions: { themeMode: "dark", themeVariables: { "--wcm-accent-color": "#FF6B1A", "--wcm-z-index": "100" } },
        metadata: {
          name: "sasa",
          description: "Launch once. Live on every chain.",
          url: window.location.origin,
          icons: [`${window.location.origin}/sasa-icon-192.png`],
        },
      });
      return p as unknown as WcProvider;
    })().catch((e) => {
      wcPromise = null;
      throw e;
    });
  }
  return wcPromise;
}

const WALLETCONNECT_OPTION: WalletOption = {
  id: WALLETCONNECT_ID,
  name: "WalletConnect",
  icon: WC_ICON,
  lazy: async () => {
    const p = await walletConnect();
    if (!p.session) await p.connect();
    return p;
  },
};

/** The legacy injected provider (typed by Privy as `any`; we narrow it here). */
const injected = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

type WalletState = {
  address: Address | null;
  walletName: string | null;
  chainId: number | null;
  wallets: WalletOption[];
  connecting: boolean;
  connect: (w: WalletOption) => Promise<void>;
  disconnect: () => void;
  /** Asks the wallet to move to `chain`, adding it first if needed. */
  switchTo: (chain: Chain) => Promise<void>;
  /** A client for sending on `chain`; call switchTo first. */
  walletClient: (chain: Chain) => WalletClient;
  /** True when signed in with email / Google: gasless, no wallet popups. */
  embedded: boolean;
  /** Email or Google address of the signed-in user, if any. */
  email: string | null;
  /** Opens the email / Google login. */
  loginWithEmail: () => void;
  /**
   * Sends one or more calls on `chain` and returns the last transaction hash
   * once mined. Browser wallets confirm each call; email users send them as
   * one gasless bundle.
   */
  send: (chain: Chain, calls: Call[], onStep?: (msg: string) => void) => Promise<Hex>;
  /** Signs a plain text message (free, no transaction). Email users sign without a popup. */
  signMessage: (message: string) => Promise<Hex>;
};

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(WalletContext);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

const SAVED_KEY = "neuron.wallet";

async function ensureNetwork(p: Eip1193, chain: Chain) {
  const chainHex = numberToHex(chain.id);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (e) {
    const err = e as { code?: number; data?: { originalError?: { code?: number } } };
    // 4902: the wallet does not know this network yet. Some wallets report it as -32603.
    if (err.code === 4902 || err.data?.originalError?.code === 4902 || err.code === -32603) {
      await p.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: [chain.blockExplorers!.default.url],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [privy, setPrivy] = useState<PrivyState | null>(null);
  const [loadPrivy, setLoadPrivy] = useState(false);
  const [loginRequests, setLoginRequests] = useState(0);
  const smartClients = useRef(new Map<string, unknown>());

  // Load the login code once the page is idle, so returning users stay signed in.
  useEffect(() => {
    const start = () => setLoadPrivy(true);
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(start);
    else setTimeout(start, 1200);
  }, []);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [active, setActive] = useState<{ option: WalletOption; provider: Eip1193 } | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const triedRestore = useRef(false);

  // Discover wallets: EIP-6963 announcements, plus window.ethereum as a fallback.
  useEffect(() => {
    const found = new Map<string, WalletOption>();
    const publish = () => setWallets([...found.values()]);
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent).detail as {
        info?: { uuid: string; name: string; icon: string; rdns: string };
        provider?: Eip1193;
      };
      if (!d?.info || !d.provider) return;
      const id = d.info.rdns || d.info.uuid;
      found.set(id, { id, name: d.info.name, icon: d.info.icon, provider: d.provider });
      publish();
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Wallets that don't announce themselves (older ones, some in-app browsers).
    const t = setTimeout(() => {
      const eth = injected();
      if (found.size === 0 && eth) {
        found.set("injected", { id: "injected", name: "Browser wallet", icon: "", provider: eth });
        publish();
      }
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(t);
    };
  }, []);

  // Follow the connected wallet's account and network.
  useEffect(() => {
    const p = active?.provider;
    if (!p) return;
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      setAddress(list && list.length > 0 ? getAddress(list[0]) : null);
    };
    const onChain = (c: unknown) => setChainId(Number(c as string));
    // A WalletConnect session can be ended from the phone.
    const onDisconnect = () => {
      if (active?.option.id !== WALLETCONNECT_ID) return;
      setActive(null);
      setAddress(null);
      setChainId(null);
    };
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    p.on?.("disconnect", onDisconnect);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
      p.removeListener?.("disconnect", onDisconnect);
    };
  }, [active]);

  // Quietly reconnect to the wallet used last time, if it still allows this site.
  useEffect(() => {
    if (triedRestore.current) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SAVED_KEY);
    } catch {}
    if (!saved) return;
    if (saved === WALLETCONNECT_ID) {
      triedRestore.current = true;
      walletConnect()
        .then(async (p) => {
          if (!p.session) return;
          const accounts = (await p.request({ method: "eth_accounts" })) as string[];
          if (!accounts.length) return;
          setActive({ option: WALLETCONNECT_OPTION, provider: p });
          setAddress(getAddress(accounts[0]));
          setChainId(Number((await p.request({ method: "eth_chainId" })) as string));
        })
        .catch(() => {});
      return;
    }
    if (wallets.length === 0) return;
    const w = wallets.find((x) => x.id === saved);
    if (!w?.provider) return;
    triedRestore.current = true;
    const provider = w.provider;
    (async () => {
      try {
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        if (accounts.length === 0) return;
        setActive({ option: w, provider });
        setAddress(getAddress(accounts[0]));
        setChainId(Number((await provider.request({ method: "eth_chainId" })) as string));
      } catch {}
    })();
  }, [wallets]);

  const connect = useCallback(async (w: WalletOption) => {
    setConnecting(true);
    try {
      const provider = w.lazy ? await w.lazy() : w.provider;
      if (!provider) throw new Error("That wallet is not available.");
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts.length === 0) throw new Error("No account was shared.");
      setActive({ option: w, provider });
      setAddress(getAddress(accounts[0]));
      try {
        localStorage.setItem(SAVED_KEY, w.id);
      } catch {}
      setChainId(Number((await provider.request({ method: "eth_chainId" })) as string));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (active?.option.id === WALLETCONNECT_ID) (active.provider as WcProvider).disconnect().catch(() => {});
    setActive(null);
    setAddress(null);
    setChainId(null);
    try {
      localStorage.removeItem(SAVED_KEY);
    } catch {}
  }, [active]);

  const switchTo = useCallback(
    async (chain: Chain) => {
      if (!active) throw new Error("Connect your wallet first.");
      const current = Number((await active.provider.request({ method: "eth_chainId" })) as string);
      if (current !== chain.id) await ensureNetwork(active.provider, chain);
      const now = Number((await active.provider.request({ method: "eth_chainId" })) as string);
      setChainId(now);
      if (now !== chain.id) throw new Error(`Please switch your wallet to ${chain.name}.`);
    },
    [active]
  );

  const walletClient = useCallback(
    (chain: Chain) => {
      if (!active || !address) throw new Error("Connect your wallet first.");
      return createWalletClient({ account: address, chain, transport: custom(active.provider) });
    },
    [active, address]
  );

  const embeddedAddress = !active && privy?.authenticated && privy.address ? getAddress(privy.address) : null;
  const embedded = !!embeddedAddress;

  const loginWithEmail = useCallback(() => {
    setLoadPrivy(true);
    setLoginRequests((n) => n + 1);
  }, []);

  const send = useCallback(
    async (chain: Chain, calls: Call[], onStep?: (msg: string) => void): Promise<Hex> => {
      if (calls.length === 0) throw new Error("Nothing to send.");
      // Email users: one gasless bundle through Alchemy, signed by their embedded wallet.
      if (!active && privy?.authenticated && privy.signer) {
        const conf = CHAINS.find((c) => c.chain.id === chain.id);
        if (!conf) throw new Error("This network is not supported.");
        const key = `${chain.id}:${privy.signer.address}`;
        let client = smartClients.current.get(key) as SmartWalletClient | undefined;
        if (!client) {
          const { createSmartWalletClient, alchemyWalletTransport } = await import("@alchemy/wallet-apis");
          client = createSmartWalletClient({
            transport: alchemyWalletTransport({ apiKey: ALCHEMY_KEY }),
            chain,
            signer: privy.signer,
            paymaster: { policyId: conf.gasPolicy },
          });
          smartClients.current.set(key, client);
        }
        onStep?.("Sending…");
        const sent = await client.sendCalls({
          calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        });
        onStep?.("Almost done…");
        // Blocks come every ~0.1-2 s on our chains: ask often.
        const status = await client.waitForCallsStatus({ id: sent.id, timeout: 90_000, pollingInterval: 400 });
        const receipts = status.receipts ?? [];
        if (status.status !== "success" || receipts.some((r) => r.status !== "success")) {
          throw new Error("The network rejected the transaction.");
        }
        return receipts[receipts.length - 1].transactionHash;
      }
      // Browser wallets: one confirmation per call, each waited for in turn.
      if (!active || !address) throw new Error("Log in or connect a wallet first.");
      onStep?.(`Switching to ${chain.name}…`);
      await switchTo(chain);
      const wc = createWalletClient({ account: address, chain, transport: custom(active.provider) });
      const conf = CHAINS.find((c) => c.chain.id === chain.id);
      const pub = conf ? clientFor(conf) : createPublicClient({ chain, transport: http() });
      let last: Hex = "0x";
      for (let i = 0; i < calls.length; i++) {
        onStep?.(calls.length > 1 ? `Step ${i + 1} of ${calls.length}: confirm in your wallet…` : "Confirm in your wallet…");
        last = await wc.sendTransaction({ account: address, chain, to: calls[i].to, data: calls[i].data, value: calls[i].value ?? 0n });
        onStep?.("Almost done…");
        const r = await pub.waitForTransactionReceipt({ hash: last });
        if (r.status !== "success") throw new Error("The network rejected the transaction.");
      }
      return last;
    },
    [active, address, privy, switchTo]
  );

  const signMessage = useCallback(
    async (message: string): Promise<Hex> => {
      if (!active && privy?.authenticated && privy.signer) {
        return privy.signer.signMessage({ message });
      }
      if (!active || !address) throw new Error("Log in or connect a wallet first.");
      const wc = createWalletClient({ account: address, transport: custom(active.provider) });
      return wc.signMessage({ account: address, message });
    },
    [active, address, privy]
  );

  const disconnectAll = useCallback(() => {
    if (active) disconnect();
    else if (privy?.authenticated) privy.logout().catch(() => {});
  }, [active, disconnect, privy]);

  const value = useMemo(
    () => ({
      address: address ?? embeddedAddress,
      walletName: active?.option.name ?? (embedded ? "sasa account" : null),
      chainId,
      wallets: [...wallets, WALLETCONNECT_OPTION],
      connecting,
      connect,
      disconnect: disconnectAll,
      switchTo,
      walletClient,
      embedded,
      email: embedded ? (privy?.email ?? null) : null,
      loginWithEmail,
      send,
      signMessage,
    }),
    [address, embeddedAddress, active, chainId, wallets, connecting, connect, disconnectAll, switchTo, walletClient, embedded, privy, loginWithEmail, send, signMessage]
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {loadPrivy && <PrivyBridge onState={setPrivy} loginRequests={loginRequests} />}
    </WalletContext.Provider>
  );
}

/** Links that open this page inside a phone wallet's own browser. */
export function walletAppLinks(): { name: string; href: string }[] {
  if (typeof window === "undefined") return [];
  const url = window.location.href;
  const bare = url.replace(/^https?:\/\//, "");
  const enc = encodeURIComponent(url);
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: "OKX Wallet", href: `okx://wallet/dapp/url?dappUrl=${enc}` },
    { name: "Phantom", href: `https://phantom.app/ul/browse/${enc}?ref=${encodeURIComponent(window.location.origin)}` },
  ];
}
