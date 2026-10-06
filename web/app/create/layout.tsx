import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create a meme coin on every chain at once · sasa",
  description: "Launch a meme coin on Robinhood Chain and Base at the same time, free. Name, ticker and picture, or let AI design it from one sentence.",
  alternates: { canonical: "/create/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
