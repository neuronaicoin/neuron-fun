import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Crypto market data: Fear & Greed, whale trades, top traders · sasa",
  description:
    "Live crypto market data: Market Fear & Greed, whale trades as they happen, the top traders on Hyperliquid and what they hold, funding rates against Binance and Bybit, and the day's movers.",
  alternates: { canonical: "/data/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
