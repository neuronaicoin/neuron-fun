import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore meme coins on Robinhood Chain and Base · sasa",
  description: "Trending, new and almost-graduated meme coins on Robinhood Chain, Base and more, ranked by real volume. Buy any of them with USDC in one tap on sasa.",
  alternates: { canonical: "/explore/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
