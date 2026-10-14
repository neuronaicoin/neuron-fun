import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Play: Chain Run and Pump Tower, the four-chain race games · sasa",
  description: "Two quick games about sasa's launch race: back a chain in Chain Run or pump its tower in Pump Tower. No score, no points, just which chain wins.",
  alternates: { canonical: "/play/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
