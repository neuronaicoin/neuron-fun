import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Futures: trade crypto with leverage · sasa",
  description: "Long or short Bitcoin, Ethereum, Solana and more with up to 20x leverage, straight from your sasa balance.",
  alternates: { canonical: "/futures/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
