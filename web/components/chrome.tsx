"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, walletAppLinks, type WalletOption } from "./wallet";
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
  const { address, walletName, wallets, connecting, connect, disconnect } = useWallet();
  const [sheet, setSheet] = useState<"none" | "pick" | "account">("none");
  const [error, setError] = useState("");
  const base =
    "h-11 px-5 rounded-xl text-[15px] font-semibold inline-flex items-center justify-center gap-2 transition-colors " +
    (full ? "w-full " : "");

  async function pick(w: WalletOption) {
    setError("");
    try {
      await connect(w);
      setSheet("none");
    } catch (e) {
      const code = (e as { code?: number }).code;
      setError(
        code === 4001
          ? "You cancelled it in your wallet."
          : `${w.name} could not connect. Try MetaMask, Rabby or Coinbase Wallet.`
      );
    }
  }

  if (address) {
    return (
      <>
        <button type="button" onClick={() => setSheet("account")} className={base + "bg-white border border-line text-ink font-mono text-[14px]"}>
          <span className="w-2 h-2 rounded-full bg-emerald" aria-hidden="true" />
          {shortAddr(address)}
        </button>
        {sheet === "account" && (
          <Sheet title="Your wallet" onClose={() => setSheet("none")}>
            <p className="text-ink-2 text-[15px]">
              Connected with {walletName ?? "your wallet"}: <span className="font-mono">{shortAddr(address)}</span>
            </p>
            <button
              type="button"
              onClick={() => {
                disconnect();
                setSheet("none");
              }}
              className="mt-5 h-12 w-full rounded-xl border border-ink font-semibold"
            >
              Disconnect
            </button>
          </Sheet>
        )}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className={base + "bg-ink text-white hover:bg-night-2 disabled:opacity-60"}
        disabled={connecting}
        onClick={() => {
          setError("");
          if (wallets.length === 1) return void pick(wallets[0]);
          setSheet("pick");
        }}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error && sheet === "none" && <p className="text-[13px] text-danger mt-2 max-w-xs">{error}</p>}
      {sheet === "pick" && (
        <Sheet title={wallets.length > 0 ? "Choose your wallet" : "You need a wallet"} onClose={() => setSheet("none")}>
          {wallets.length > 0 ? (
            <div className="grid gap-2">
              {wallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={connecting}
                  onClick={() => pick(w)}
                  className="h-14 px-4 rounded-xl border border-line bg-white flex items-center gap-3 text-left font-semibold hover:border-emerald disabled:opacity-60"
                >
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" width={30} height={30} className="rounded-lg" />
                  ) : (
                    <span className="w-[30px] h-[30px] rounded-lg bg-mist" aria-hidden="true" />
                  )}
                  {w.name}
                </button>
              ))}
            </div>
          ) : (
            <>
              <p className="text-ink-2 text-[15px] leading-relaxed">
                A wallet is an app that holds your coins. On a phone, open this page inside your wallet app. On a
                computer, install a wallet extension such as MetaMask or Rabby and refresh.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {walletAppLinks().map((l) => (
                  <a key={l.name} href={l.href} className="h-12 px-3 rounded-xl bg-emerald text-white text-[14px] font-semibold flex items-center justify-center text-center">
                    {l.name}
                  </a>
                ))}
              </div>
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
                className="mt-3 h-12 rounded-xl border border-ink text-ink font-semibold flex items-center justify-center"
              >
                Get a wallet
              </a>
            </>
          )}
          {error && <p className="text-[14px] text-danger mt-4" role="alert">{error}</p>}
        </Sheet>
      )}
    </>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Rendered into <body>: a parent with backdrop blur would otherwise trap
  // this "fixed" overlay inside itself.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full sm:max-w-md max-h-[85dvh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-6 safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="font-display text-[22px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 -mr-2 rounded-full text-ink-3 text-[26px] leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

const NAV = [
  { href: "/", label: "Explore" },
  { href: "/create/", label: "Create a coin" },
  { href: "/me/", label: "Your coins" },
  { href: "/how-it-works/", label: "How it works" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href.replace(/\/$/, ""));
}

export function Header() {
  const pathname = usePathname() || "/";
  return (
    <header className="relative md:sticky md:top-0 z-40 bg-paper/90 md:backdrop-blur border-b border-line">
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
      <div className="grid grid-cols-4">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={"flex flex-col items-center gap-1 py-1 text-[12px] font-semibold " + (active ? "text-emerald" : "text-ink-3")}
            >
              <NavIcon name={n.label} />
              {n.label === "Create a coin" ? "Create" : n.label === "How it works" ? "Help" : n.label === "Your coins" ? "You" : n.label}
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
  if (name === "Your coins")
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21 c1.5 -4 4.5 -6 8 -6 s6.5 2 8 6" />
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
            funds. Earlier NEURONAI tokens are not related to this platform.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] font-medium">
          <Link href="/how-it-works/" className="text-emerald">How it works</Link>
          <a href="https://x.com/neuronfun" target="_blank" rel="noreferrer" className="text-emerald">X</a>
        </nav>
      </div>
    </footer>
  );
}
