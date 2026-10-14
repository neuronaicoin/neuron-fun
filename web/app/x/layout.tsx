import type { Metadata } from "next";

export const metadata: Metadata = { title: "Coin · sasa", alternates: { canonical: "/x/" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
