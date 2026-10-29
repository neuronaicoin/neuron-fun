import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live price, chart and trading · sasa",
  description: "Live price and chart. Buy and sell it with USDC in one tap on sasa.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
