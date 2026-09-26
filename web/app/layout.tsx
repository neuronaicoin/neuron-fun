import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { Header, BottomNav, Footer, TestnetBanner } from "@/components/chrome";
import { Landing } from "@/components/landing";

const SITE = "https://sasapad.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "sasa — Launch once. Live on every chain.",
  description:
    "sasa launches your coin on every chain at the same time. Testnet live, mainnet coming soon.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "sasa — Launch once. Live on every chain.",
    description: "The multi-chain launchpad. Testnet live, mainnet coming soon.",
    url: SITE,
    siteName: "sasa",
    type: "website",
    images: [{ url: "/og.png", width: 1600, height: 900, alt: "sasa — Launch once. Live on every chain." }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@sasapadfun",
    title: "sasa — Launch once. Live on every chain.",
    description: "The multi-chain launchpad. Testnet live, mainnet coming soon.",
    images: ["/og.png"],
  },
};

/** Runs before first paint: sasapad.fun (or ?landing) shows the pre-launch page. */
const HOST_CHECK = String.raw`try{var h=location.hostname;if(/(^|\.)sasapad\.(fun|com)$/.test(h)||/[?&]landing\b/.test(location.search)){document.documentElement.classList.add("is-landing")}}catch(e){}`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script dangerouslySetInnerHTML={{ __html: HOST_CHECK }} />
      </head>
      <body className="min-h-dvh flex flex-col">
        <div className="landing-root">
          <Landing />
        </div>
        <div className="app-root flex-1 flex flex-col">
          <WalletProvider>
            <TestnetBanner />
            <Header />
            <main className="flex-1 w-full">{children}</main>
            <Footer />
            <BottomNav />
          </WalletProvider>
        </div>
      </body>
    </html>
  );
}
