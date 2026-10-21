import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Airdrop · sasa",
  description: "Create coins and trade on sasa to earn the future sasa airdrop. The more you create and trade, the bigger your share.",
  alternates: { canonical: "/points/" },
};

export default function PointsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
