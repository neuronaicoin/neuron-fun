import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Earn · sasa",
  description: "Earn real USDC on sasa: fees from the coins you create, 25% of sasa's fees from friends you invite, and the creator competition.",
  alternates: { canonical: "/points/" },
};

export default function PointsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
