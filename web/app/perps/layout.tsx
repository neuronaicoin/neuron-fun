import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Perps: trade crypto with leverage · sasa",
  description: "Long or short Bitcoin, Ethereum, Solana and more with up to 20x leverage, from your sasa balance. Powered by Hyperliquid.",
  alternates: { canonical: "/perps/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
