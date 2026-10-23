import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Predict: yes or no on prices, matches and rates · sasa",
  description: "Will Bitcoin be above a price tomorrow? Who wins tonight's match? Will the Fed cut? Pick yes or no; the right answer pays $1 a share.",
  alternates: { canonical: "/predict/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
