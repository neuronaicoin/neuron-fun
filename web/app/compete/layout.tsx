import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Win up to $100,000: launch on sasa · sasa",
  description: "Launch coins on sasa until November 25. The creator whose coins get the most trading volume wins up to $100,000. Plus 30% of your coins' fees and airdrop points.",
  alternates: { canonical: "/compete/" },
};

export default function CompeteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
