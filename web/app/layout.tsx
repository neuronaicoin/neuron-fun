import type { Metadata, Viewport } from "next";
// No web fonts: the phone's own system font (fast, native on iPhone and Android).
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { Header, BottomNav, Footer, TestnetBanner, PauseBanner } from "@/components/chrome";
import { IS_TESTNET } from "@/lib/config";

const SITE = "https://sasapad.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  alternates: { canonical: "/" },
  title: "sasa — Launch once. Live on every chain.",
  description:
    IS_TESTNET
      ? "sasa launches your coin on every chain at the same time. Testnet live, mainnet coming soon."
      : "sasa launches your coin on every chain at the same time. Buy any coin in USDC in one tap: no wallet, no gas, no bridge.",
  icons: {
    icon: [
      { url: "/sasa-icon.svg", type: "image/svg+xml" },
      { url: "/sasa-icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Lets phones add sasa to the Home Screen (needed for alerts on iPhone).
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "sasa", statusBarStyle: "black" },
  openGraph: {
    title: "sasa — Launch once. Live on every chain.",
    description: IS_TESTNET ? "The multi-chain launchpad. Testnet live, mainnet coming soon." : "The multi-chain launchpad. Launch once, live on every chain.",
    url: SITE,
    siteName: "sasa",
    type: "website",
    images: [
      IS_TESTNET
        ? { url: "/og-sasa.png", width: 1200, height: 630, alt: "sasa — Trade any coin. Launch your own." }
        : { url: "/og-sasa.png", width: 1200, height: 630, alt: "sasa — Launch once. Live on every chain." },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@sasapadfun",
    title: "sasa — Launch once. Live on every chain.",
    description: IS_TESTNET ? "The multi-chain launchpad. Testnet live, mainnet coming soon." : "The multi-chain launchpad. Launch once, live on every chain.",
    images: [IS_TESTNET ? "/og-sasa.png" : "/og-sasa.png"],
  },
};

/**
 * Runs before first paint. On sasapad.fun the home page is the pre-launch
 * page; /learn pages always use their own simple chrome.
 */
const HOST_CHECK = (IS_TESTNET ? "" : "var NOLANDING=1;") + String.raw`try{var h=location.hostname,p=location.pathname,c=document.documentElement.classList;if(p.indexOf("/learn")===0){c.add("is-learn")}else if(typeof NOLANDING==="undefined"&&p==="/"&&(/(^|\.)sasapad\.(fun|com)$/.test(h)||/[?&]landing\b/.test(location.search))){c.add("is-landing")}}catch(e){}`;
/** Runs before first paint: the saved theme, light by default. No flash. */
const THEME_CHECK = String.raw`try{var t=localStorage.getItem("sasa-theme");if(t!=="light"&&t!=="dark"){t="light"}document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","light")}`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Inputs are under 16px on phones; this stops iOS zooming in on focus.
  // People can still pinch-zoom (iOS ignores this for manual zoom).
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: HOST_CHECK }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_CHECK }} />
      </head>
      <body className="min-h-dvh flex flex-col">
        <WalletProvider>
          <div className="app-chrome">
            <TestnetBanner />
            <PauseBanner />
            <Header />
          </div>
          {/* At least a screen tall: the footer never sits mid-page and then jumps down when data arrives (layout shift). */}
          <main className="flex-1 w-full min-h-[100dvh]">{children}</main>
          <div className="app-chrome">
            <Footer />
            <BottomNav />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
