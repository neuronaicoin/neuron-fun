import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meme coin trading terminal · sasa",
  description: "Live charts, trades and holders for every meme coin on Robinhood Chain and Base. Trade with USDC in one tap, set take profit and stop loss.",
  alternates: { canonical: "/terminal/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
