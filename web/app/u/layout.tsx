import type { Metadata } from "next";

export const metadata: Metadata = { title: "Profile · sasa", alternates: { canonical: "/u/" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
