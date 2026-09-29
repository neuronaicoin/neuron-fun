import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Points · sasa",
  description: "Earn points on sasa: trade, launch, invite friends and complete quests. Climb the Season 0 leaderboard.",
};

export default function PointsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
