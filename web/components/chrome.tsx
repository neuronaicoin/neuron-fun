"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, walletAppLinks } from "./wallet";
import { IS_TESTNET } from "@/lib/config";
import { shortAddr } from "@/lib/format";

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <rect width="34" height="34" rx="8" fill="#0F6B52" />
      <path d="M11 24 L11 10 L23 24 L23 10" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="24" r="2.6" fill="#FFFFFF" />
      <circle cx="23" cy="10" r="2.6" fill="#FFFFFF" />
    </svg>
  );
}

export function TestnetBanner() {
  if (!IS_TESTNET) return null;
  return (
    <div className="bg-ink text-mist text-center text-[13px] leading-snug px-4 py-2">
      Test version. It uses free test ETH, so nothing here has real value.
    </div>
  );
}

export function ConnectButton({ full = false }: { full?: boolean }) {
  const { address, onRightNetwork, hasWallet, connecting, connect, switchNetwork } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const base =
    "h-11 px-5 rounded-xl text-[15px] font-semibold inline-flex items-center justify-center gap-2 transition-colors " +
    (full ? "w-full " : "");

  if (address && !onRightNetwork) {
    return (
      <button type="button" className={base + "bg-warn-bg text-warn-ink"} onClick={() => switchNetwork().catch(() => {})}>
        Switch network
      </button>
    );
  }
  if (address) {
    return (
      <span className={base + "bg-white border border-line text-ink font-mono text-[14px]"}>
        <span className="w-2 h-2 rounded-full bg-emerald" aria-hidden="true" />
        {shortAddr(address)}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={base + "bg-ink text-white hover:bg-night-2 disabled:opacity-60"}
        disabled={connecting}
        onClick={async () => {
          setError("");
          if (!hasWallet) return setOpen(true);
          try {
            await connect();
          } catch {
            setError("Connection was not completed.");
          }
        }}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error && <p className="text-[13px] text-danger mt-2">{error}</p>}
      {open && <NoWalletSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function NoWalletSheet({ onClose }: { onClose: () => void }) {
  const links = walletAppLinks();
  // Rendered into <body>: the sticky header's backdrop blur would otherwise
  // trap this "fixed" overlay inside the header.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nowallet-title"
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-6 safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="nowallet-title" className="font-display text-[22px] font-semibold">You need a wallet</h2>
        <p className="text-ink-2 mt-2 text-[15px] leading-relaxed">
          A wallet is an app that holds your coins. On a phone, open this page inside your wallet app. On a computer,
          install the MetaMask browser extension and refresh.
        </p>
        <div className="mt-5 grid gap-3">
          {links.map((l) => (
            <a key={l.name} href={l.href} className="h-12 rounded-xl bg-emerald text-white font-semibold flex items-center justify-center">
              Open in {l.name}
            </a>
          ))}
          
            href="https://metamask.io/download/"
            target="_blank"
            rel="noreferrer"
            className="h-12 rounded-xl border border-ink text-ink font-semibold flex items-center justify-center"
          >
            Get MetaMask
          </a>
          <button type="button" onClick={onClose} className="h-11 text-ink-3 font-medium">
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const NAV = [
  { href: "/", label: "Explore" },
  { href: "/create/", label: "Create a coin" },
  { href: "/how-it-works/", label: "How it works" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href.replace(/\/$/, ""));
}

export function Header() {
  const pathname = usePathname() || "/";
  return (
    <header className="sticky top-0 z-40 bg-paper/90 backdrop-blur border-b border-line">
      <div className="max-w-6xl mx-auto h-16 px-4 sm:px-6 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 text-ink shrink-0">
          <LogoMark />
          <span className="font-display font-semibold text-[19px] tracking-tight">Neuron.fun</span>
        </Link>
        <nav aria-label="Main" className="hidden md:flex items-center gap-7 text-[15px] font-medium">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={isActive(pathname, n.href) ? "text-emerald" : "text-ink hover:text-emerald"}>
              {n.label}
            </Link>
          ))}
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname() || "/";
  return (
    <nav aria-label="Main" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-paper/95 backdrop-blur border-t border-line safe-bottom pt-2">
      <div className="grid grid-cols-3">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={"flex flex-col items-center gap-1 py-1 text-[12px] font-semibold " + (active ? "text-emerald" : "text-ink-3")}
            >
              <NavIcon name={n.label} />
              {n.label === "Create a coin" ? "Create" : n.label === "How it works" ? "How it works" : n.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function NavIcon({ name }: { name: string }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "Explore")
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20 L16 16" />
      </svg>
    );
  if (name === "Create a coin")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8 V16 M8 12 H16" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5 a2.5 2.5 0 1 1 3.5 2.3 c-.7.3-1 .8-1 1.5 V14" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-paper mt-16 pb-24 md:pb-0">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2.5">
            <LogoMark size={26} />
            <span className="font-display font-semibold">Neuron.fun</span>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-2 mt-3">
            Meme coins are risky and can lose all their value. Only use money you can afford to lose. Nothing on this
            site is financial advice. Every transaction is signed in your own wallet; Neuron.fun never holds your
            funds. $NEURON is the platform token. Earlier NEURONAI tokens are not related to this platform.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] font-medium">
          <Link href="/how-it-works/" className="text-emerald">How it works</Link>
          <a href="https://x.com/neuronaicoin" target="_blank" rel="noreferrer" className="text-emerald">X</a>
        </nav>
      </div>
    </footer>
  );
}
