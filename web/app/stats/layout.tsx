import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa stats: races, launches and volume",
  description: "Live on-chain numbers for sasa: races and the chain league, coins launched, trading volume, graduations, creator earnings and holders across every chain.",
  alternates: { canonical: "/stats/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
