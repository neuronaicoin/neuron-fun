"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, numberToHex, type Address, type WalletClient } from "viem";
import { chain } from "@/lib/config";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, fn: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...a: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

type WalletState = {
  address: Address | null;
  onRightNetwork: boolean;
  hasWallet: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
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

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    setHasWallet(true);
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      setAddress(list && list.length > 0 ? getAddress(list[0]) : null);
    };
    const onChain = (c: unknown) => setChainId(Number(c as string));
    // Already connected before? Pick it up silently.
    eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const switchNetwork = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      // 4902: the wallet does not know this network yet.
      if (code === 4902 || code === -32603) {
        await eth.request({
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
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    setConnecting(true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts.length > 0) setAddress(getAddress(accounts[0]));
      const current = Number((await eth.request({ method: "eth_chainId" })) as string);
      setChainId(current);
      if (current !== chain.id) await switchNetwork();
    } finally {
      setConnecting(false);
    }
  }, [switchNetwork]);

  const walletClient = useCallback(() => {
    const eth = window.ethereum;
    if (!eth || !address) throw new Error("Connect your wallet first.");
    return createWalletClient({ account: address, chain, transport: custom(eth) });
  }, [address]);

  const value = useMemo(
    () => ({
      address,
      onRightNetwork: chainId === chain.id,
      hasWallet,
      connecting,
      connect,
      switchNetwork,
      walletClient,
    }),
    [address, chainId, hasWallet, connecting, connect, switchNetwork, walletClient]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Links that open this page inside a phone wallet's built-in browser. */
export function walletAppLinks(): { name: string; href: string }[] {
  if (typeof window === "undefined") return [];
  const url = window.location.href;
  const bare = url.replace(/^https?:\/\//, "");
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  ];
}
