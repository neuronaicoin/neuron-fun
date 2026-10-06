import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Top meme coin traders · sasa",
  description: "The best meme coin traders on sasa by profit and volume. Follow them, get alerts when they buy, and copy their trades.",
  alternates: { canonical: "/traders/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
