import type { Metadata } from "next";

export const metadata: Metadata = { title: "Coin · sasa" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
