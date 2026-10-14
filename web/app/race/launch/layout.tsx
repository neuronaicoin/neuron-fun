import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create a meme coin on four chains at once · sasa",
  description: "Launch one coin on Base, BNB Chain, Robinhood Chain and Arc at the same time. Five minutes later the chain with the most money wins and keeps it, locked forever.",
  alternates: { canonical: "/race/launch/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
