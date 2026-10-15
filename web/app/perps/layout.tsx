import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Futures · sasa",
  alternates: { canonical: "/futures/" },
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
