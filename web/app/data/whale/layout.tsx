import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trader positions · sasa",
  description: "What a top Hyperliquid trader holds right now, live, and their latest trades.",
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
