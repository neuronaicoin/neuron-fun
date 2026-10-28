import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa Bot: meme coin whales, rug checks and trends, live · sasa",
  description:
    "sasa Bot scans every new meme coin live: it catches traps (creators who sell, bundles, copies), follows wallets that keep getting in early, tracks futures WHALES and shows which themes are trending right now.",
  alternates: { canonical: "/bot/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
