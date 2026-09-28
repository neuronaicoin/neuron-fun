"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, walletAppLinks, type WalletOption } from "./wallet";
import { CHAINS, IS_TESTNET } from "@/lib/config";
import { useSafety } from "@/lib/safety";
import { SasaMark } from "./landing";
import { shortAddr } from "@/lib/format";
import { AlertsSync, HeaderBell } from "./alerts";
import { BalancePill, MoneyHost } from "./portfolio";
import { SocialSync } from "./social";

export function LogoMark({ size = 32 }: { size?: number }) {
  return <SasaMark size={size} />;
}

export function TestnetBanner() {
  if (!IS_TESTNET) return null;
  return (
    <div className="bg-paper border-b border-line text-ink-3 text-center text-[0.75rem] leading-snug px-4 py-1.5"><span className="inline-block w-1.5 h-1.5 rounded-full bg-warn-ink mr-2 align-middle" aria-hidden="true" />
      <span className="sm:hidden">Testnet · free test ETH, no real value</span>
      <span className="hidden sm:inline">Test version. It uses free test ETH, so nothing here has real value.</span>
    </div>
  );
}

/** Shown on every app page while buying is paused on any chain (beta safety lock). */
export function PauseBanner() {
  const safety = useSafety();
  const paused = CHAINS.filter((c) => safety[c.key]?.paused).map((c) => c.short);
  if (!paused.length) return null;
  const where =
    paused.length === CHAINS.length ? "every chain" : paused.length === 1 ? paused[0] : `${paused.slice(0, -1).join(", ")} and ${paused[paused.length - 1]}`;
  return (
    <div role="status" className="bg-warn-bg text-warn-ink text-center text-[0.8125rem] leading-snug px-4 py-2 border-b border-line">
      <span aria-hidden="true" className="mr-1.5">⏸</span>
      Buying on {where} is paused for a moment. Selling works as usual.
    </div>
  );
}

export function ConnectButton({ full = false }: { full?: boolean }) {
  const { address, wallets, connecting, connect, loginWithEmail } = useWallet();
  const [sheet, setSheet] = useState<"none" | "pick">("none");
  const [error, setError] = useState("");
  const base =
    "h-11 px-5 rounded-xl text-[0.9375rem] font-semibold inline-flex items-center justify-center gap-2 transition-colors " +
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

  // Logged in: the balance (opens the portfolio, with address and log out) and ＋ Deposit.
  if (address) return <BalancePill />;
  return (
    <>
      <button
        type="button"
        className={base + "bg-ink text-on-accent hover:bg-ink-2 disabled:opacity-60"}
        disabled={connecting}
        onClick={() => {
          setError("");
          setSheet("pick");
        }}
      >
        {connecting ? "Connecting…" : "Log in"}
      </button>
      {error && sheet === "none" && <p className="text-[0.8125rem] text-danger mt-2 max-w-xs">{error}</p>}
      {sheet === "pick" && (
        <Sheet title="Log in to sasa" onClose={() => setSheet("none")}>
          <button
            type="button"
            onClick={() => {
              setSheet("none");
              loginWithEmail();
            }}
            className="h-14 w-full rounded-xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark"
          >
            Continue with email or Google
          </button>
          <p className="text-[0.75rem] text-ink-3 mt-2 text-center">No wallet needed. No network fees.</p>
          <div className="flex items-center gap-3 my-5 text-[0.75rem] text-ink-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or use your own wallet
            <span className="h-px flex-1 bg-line" />
          </div>
          {wallets.length > 0 ? (
            <div className="grid gap-2">
              {wallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={connecting}
                  onClick={() => pick(w)}
                  className="h-14 px-4 rounded-xl border border-line bg-surface flex items-center gap-3 text-left font-semibold hover:border-emerald disabled:opacity-60"
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
              <p className="text-ink-2 text-[0.9375rem] leading-relaxed">
                A wallet is an app that holds your coins. On a phone, open this page inside your wallet app. On a
                computer, install a wallet extension such as MetaMask or Rabby and refresh.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {walletAppLinks().map((l) => (
                  <a key={l.name} href={l.href} className="h-12 px-3 rounded-xl bg-emerald text-on-accent text-[0.875rem] font-semibold flex items-center justify-center text-center">
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
          {error && <p className="text-[0.875rem] text-danger mt-4" role="alert">{error}</p>}
        </Sheet>
      )}
    </>
  );
}

/** ☀ / ☾ switch. Remembers the choice; until then the device setting wins. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  }, []);
  const flip = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sasa-theme", next);
    } catch {}
    setTheme(next);
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      title={theme === "light" ? "Dark mode" : "Light mode"}
      className="w-10 h-10 shrink-0 rounded-xl border border-line text-ink-2 hover:text-ink flex items-center justify-center"
    >
      {theme === "light" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Rendered into <body>: a parent with backdrop blur would otherwise trap
  // this "fixed" overlay inside itself.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full sm:max-w-md max-h-[85dvh] overflow-y-auto bg-surface rounded-t-3xl sm:rounded-3xl p-6 safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="font-display text-[1.375rem] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 -mr-2 rounded-full text-ink-3 text-[1.625rem] leading-none">
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
  { href: "/explore/", label: "Explore" },
  { href: "/terminal/", label: "Terminal" },
  { href: "/create/", label: "Create a coin" },
  { href: "/me/", label: "Your coins" },
  { href: "/traders/", label: "Traders" },
  { href: "/forum/", label: "Forum" },
  { href: "/stats/", label: "Stats" },
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
        <Link href="/explore/" className="flex items-center gap-2.5 text-ink shrink-0">
          <LogoMark />
          <span className="font-display font-bold text-[1.375rem] tracking-tight">sasa</span>
        </Link>
        <nav aria-label="Main" className="hidden md:flex items-center gap-7 text-[0.9375rem] font-medium">
          {NAV.map((n) =>
            n.href === "/forum/" ? (
              // The forum is server-rendered HTML, not part of the app: a normal link.
              <a key={n.href} href={n.href} className="text-ink hover:text-emerald">
                {n.label}
              </a>
            ) : (
              <Link key={n.href} href={n.href} className={isActive(pathname, n.href) ? "text-emerald" : "text-ink hover:text-emerald"}>
                {n.label}
              </Link>
            )
          )}
        </nav>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <AlertsSync />
          <MoneyHost />
          <SocialSync />
          <ThemeToggle />
          <HeaderBell />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname() || "/";
  return (
    <nav aria-label="Main" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-paper/95 backdrop-blur border-t border-line safe-bottom pt-2">
      <div className="grid grid-cols-4">
        {NAV.filter((n) => n.href !== "/stats/" && n.href !== "/forum/" && n.href !== "/traders/").map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={"flex flex-col items-center gap-1 py-1 text-[0.75rem] font-semibold " + (active ? "text-emerald" : "text-ink-3")}
            >
              <NavIcon name={n.label} />
              {n.label === "Create a coin" ? "Create" : n.label === "Your coins" ? "You" : n.label === "Terminal" ? "Trade" : n.label}
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
  if (name === "Terminal")
    return (
      <svg {...common}>
        <path d="M4 17 L9 11 L13 14 L20 6" />
        <path d="M15 6 H20 V11" />
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
            <span className="font-display font-bold">sasa</span>
          </div>
          <p className="text-[0.8125rem] leading-relaxed text-ink-2 mt-3">
            Meme coins are risky and can lose all their value. Only use money you can afford to lose. Nothing on this
            site is financial advice. Every transaction is signed in your own wallet; sasa never holds your
            funds.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[0.875rem] font-medium">
          <a href="/forum/" className="text-emerald">Forum</a>
          <Link href="/how-it-works/" className="text-emerald">How it works</Link>
          <Link href="/learn/" className="text-emerald">Learn</Link>
          <Link href="/stats/" className="text-emerald">Stats</Link>
          <a href="https://x.com/sasapadfun" target="_blank" rel="noreferrer" className="text-emerald">X</a>
        </nav>
      </div>
    </footer>
  );
}
