import type { Metadata } from "next";

export const metadata: Metadata = { title: "Race · sasa", alternates: { canonical: "/r/" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
