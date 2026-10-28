import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Is it safe? Free meme coin rug check for Elysium, Base, BNB Chain · sasa",
  description:
    "Paste any coin's contract address and see in seconds if it's a trap: can it be sold, taxes, can the owner print more, who holds it, is the liquidity locked. Free, for Elysium, Base, BNB Chain, Robinhood Chain and Ethereum.",
  alternates: { canonical: "/scan/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
