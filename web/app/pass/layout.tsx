import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa Day-1 Pass: free on Elysium, 2x points · sasa",
  description: "Mint the sasa Day-1 Pass for free on Elysium. One per wallet. Holders earn 2x sasa points on every Elysium launch and trade.",
  alternates: { canonical: "/pass/" },
  openGraph: { title: "sasa Day-1 Pass: free, 2x points", description: "One per wallet, free on Elysium.", url: "/pass/", images: ["/pass.png"] },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
