import type { Metadata } from "next";
import { RaceTeaser } from "@/components/racepromo";

export const metadata: Metadata = {
  title: "The 5-minute race: one coin, one CA, every chain · sasa",
  description:
    "Coming soon to sasa: launch a meme coin once and it goes live on Uniswap on every chain at the same moment, with one contract address. No bonding curve. Five-minute race, one winner, one deep pool.",
  alternates: { canonical: "/race/" },
  openGraph: { title: "One coin. One CA. Every chain.", description: "No bonding curve. Live on Uniswap on every chain at once. Five-minute race, one winner.", url: "/race/" },
};

const STEPS: [string, string, string][] = [
  ["01", "Launch on every chain", "Pick the chains. Your coin opens on Uniswap on all of them at once, with the same contract address, and shows on DexScreener in seconds."],
  ["02", "Five-minute race", "Buyers pick a chain with \"Buy on\" buttons. A live board shows which chain is leading and how long is left."],
  ["03", "One winner", "The chain with the most money wins. Every other chain's money moves into the winner's pool, holders' coins move with it, and the pool is locked forever."],
];

export default function RacePage() {
  return (
    <div className="race-page">
      <RaceTeaser headingLevel={1} />
      <section className="race-steps" aria-label="How the race works">
        {STEPS.map(([n, t, d]) => (
          <div key={n} className="race-step">
            <span>{n}</span>
            <h2>{t}</h2>
            <p>{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
