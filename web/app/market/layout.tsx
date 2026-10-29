import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Crypto market: top 500 coins, prices and charts · sasa",
  description: "Prices, charts and market caps of the 500 biggest crypto coins, from Bitcoin and Ethereum down. Buy and sell any of them with USDC in one tap on sasa.",
  alternates: { canonical: "/market/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
