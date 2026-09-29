import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Discover coins · sasa",
  description: "Swipe through new meme coins on sasa. Right to buy, left to skip, up to save.",
};

export default function SwipeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
