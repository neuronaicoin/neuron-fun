import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa Pulse: the whole crypto market live, whale trades, futures, stocks and odds · sasa",
  description:
    "One live screen: whale trades as they happen, futures open interest and funding, stocks 24/7, prediction odds, Fear & Greed and the top 500 coins' movers.",
  alternates: { canonical: "/pulse/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
