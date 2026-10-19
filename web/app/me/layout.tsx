import type { Metadata } from "next";

export const metadata: Metadata = { title: "You · sasa", robots: { index: false, follow: true }, alternates: { canonical: "/me/" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
