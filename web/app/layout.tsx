import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { Header, BottomNav, Footer, TestnetBanner } from "@/components/chrome";

export const metadata: Metadata = {
  title: "Neuron.fun — Launch once. Live on every chain.",
  description:
    "Launch a meme coin on every chain at once. Buyers everywhere push it to graduation together.",
  openGraph: {
    title: "Neuron.fun",
    description: "Launch once. Live on every chain.",
    type: "website",
  },
};

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
      </head>
      <body className="min-h-dvh flex flex-col">
        <WalletProvider>
          <TestnetBanner />
          <Header />
          <main className="flex-1 w-full">{children}</main>
          <Footer />
          <BottomNav />
        </WalletProvider>
      </body>
    </html>
  );
}
