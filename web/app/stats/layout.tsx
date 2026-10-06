import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa stats: launches, volume and graduations",
  description: "Live on-chain numbers for sasa: coins launched, trading volume, graduations, creator earnings and holders across every chain.",
  alternates: { canonical: "/stats/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
