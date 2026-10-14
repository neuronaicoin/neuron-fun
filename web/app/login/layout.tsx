import type { Metadata } from "next";

export const metadata: Metadata = { title: "Log in · sasa", robots: { index: false, follow: true }, alternates: { canonical: "/login/" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
