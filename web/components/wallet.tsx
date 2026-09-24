"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, numberToHex, type Address, type WalletClient } from "viem";
import { chain } from "@/lib/config";

export type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, fn: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...a: unknown[]) => void) => void;
};

/** A wallet found in this browser (EIP-6963), or the legacy window.ethereum. */
export type WalletOption = {
  id: string;
  name: string;
  icon: string;
  provider: Eip1193;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

type WalletState = {
  address: Address | null;
  walletName: string | null;
  onRightNetwork: boolean;
  wallets: WalletOption[];
  connecting: boolean;
  connect: (w: WalletOption) => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
  walletClient: () => WalletClient;
};

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(WalletContext);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

const chainHex = numberToHex(chain.id);
const SAVED_KEY = "neuron.wallet";

async function ensureNetwork(p: Eip1193) {
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
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [active, setActive] = useState<WalletOption | null>(null);
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
      if (found.size === 0 && window.ethereum) {
        found.set("injected", { id: "injected", name: "Browser wallet", icon: "", provider: window.ethereum });
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
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [active]);

  // Quietly reconnect to the wallet used last time, if it still allows this site.
  useEffect(() => {
    if (triedRestore.current || wallets.length === 0) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SAVED_KEY);
    } catch {}
    const w = wallets.find((x) => x.id === saved);
    if (!w) return;
    triedRestore.current = true;
    (async () => {
      try {
        const accounts = (await w.provider.request({ method: "eth_accounts" })) as string[];
        if (accounts.length === 0) return;
        setActive(w);
        setAddress(getAddress(accounts[0]));
        setChainId(Number((await w.provider.request({ method: "eth_chainId" })) as string));
      } catch {}
    })();
  }, [wallets]);

  const connect = useCallback(async (w: WalletOption) => {
    setConnecting(true);
    try {
      const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts.length === 0) throw new Error("No account was shared.");
      setActive(w);
      setAddress(getAddress(accounts[0]));
      try {
        localStorage.setItem(SAVED_KEY, w.id);
      } catch {}
      let current = Number((await w.provider.request({ method: "eth_chainId" })) as string);
      if (current !== chain.id) {
        await ensureNetwork(w.provider);
        current = Number((await w.provider.request({ method: "eth_chainId" })) as string);
      }
      setChainId(current);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setActive(null);
    setAddress(null);
    setChainId(null);
    try {
      localStorage.removeItem(SAVED_KEY);
    } catch {}
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!active) return;
    await ensureNetwork(active.provider);
    setChainId(Number((await active.provider.request({ method: "eth_chainId" })) as string));
  }, [active]);

  const walletClient = useCallback(() => {
    if (!active || !address) throw new Error("Connect your wallet first.");
    return createWalletClient({ account: address, chain, transport: custom(active.provider) });
  }, [active, address]);

  const value = useMemo(
    () => ({
      address,
      walletName: active?.name ?? null,
      onRightNetwork: chainId === chain.id,
      wallets,
      connecting,
      connect,
      disconnect,
      switchNetwork,
      walletClient,
    }),
    [address, active, chainId, wallets, connecting, connect, disconnect, switchNetwork, walletClient]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
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
