import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { Header, BottomNav, Footer, TestnetBanner, PauseBanner } from "@/components/chrome";

const SITE = "https://sasapad.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  alternates: { canonical: "/" },
  title: "sasa — Launch once. Live on every chain.",
  description:
    "sasa launches your coin on every chain at the same time. Testnet live, mainnet coming soon.",
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
    description: "The multi-chain launchpad. Testnet live, mainnet coming soon.",
    url: SITE,
    siteName: "sasa",
    type: "website",
    images: [{ url: "/og-2.png", width: 1200, height: 630, alt: "sasa — Trade any coin. Launch your own. Testnet live, mainnet soon." }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@sasapadfun",
    title: "sasa — Launch once. Live on every chain.",
    description: "The multi-chain launchpad. Testnet live, mainnet coming soon.",
    images: ["/og-2.png"],
  },
};

/**
 * Runs before first paint. On sasapad.fun the home page is the pre-launch
 * page; /learn pages always use their own simple chrome.
 */
const HOST_CHECK = String.raw`try{var h=location.hostname,p=location.pathname,c=document.documentElement.classList;if(p.indexOf("/learn")===0){c.add("is-learn")}else if(p==="/"&&(/(^|\.)sasapad\.(fun|com)$/.test(h)||/[?&]landing\b/.test(location.search))){c.add("is-landing")}}catch(e){}`;
/** Runs before first paint: the saved theme, or the phone/computer setting. No flash. */
const THEME_CHECK = String.raw`try{var t=localStorage.getItem("sasa-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Inputs are under 16px on phones; this stops iOS zooming in on focus.
  // People can still pinch-zoom (iOS ignores this for manual zoom).
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0d0c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
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
          <main className="flex-1 w-full">{children}</main>
          <div className="app-chrome">
            <Footer />
            <BottomNav />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
