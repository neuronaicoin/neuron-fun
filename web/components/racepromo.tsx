"use client";

/**
 * "The 5-minute race" (coming soon): one coin, one contract address, live on every chain
 * at once, then the chains race for five minutes. Shown on the home page, at the top of
 * Explore and on /race/.
 */
const X_URL = "https://x.com/sasapadfun";

const CHAINS = [
  { n: "Robinhood", c: "#12B886" },
  { n: "Base", c: "#3B6FF5" },
  { n: "BNB", c: "#E0A400" },
  { n: "Arc", c: "#8B7CF6" },
];

const POINTS: [string, string][] = [
  ["One coin, one CA", "The same contract address on every chain you pick, live at the same moment."],
  ["No bonding curve", "Live on Uniswap from the first second, on DexScreener in seconds."],
  ["Five-minute race", "Buyers pick a chain. The chain with the most money wins."],
  ["One deep pool", "All the money from every chain lands in the winner's pool, locked forever."],
];

/** Small looping race: four bars that overtake each other (pure CSS, no data). */
export function RaceBars({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`race-bars${compact ? " race-bars-c" : ""}`} aria-hidden="true">
      {CHAINS.map((ch, i) => (
        <div key={ch.n} className="race-lane">
          <span className="race-name"><i style={{ background: ch.c }} />{ch.n}</span>
          <span className="race-track"><b style={{ background: ch.c, animationDelay: `${-i * 1.7}s` }} /></span>
        </div>
      ))}
    </div>
  );
}

/** Full section for the home page and /race/. */
export function RaceTeaser({ headingLevel = 2 }: { headingLevel?: 1 | 2 }) {
  const H = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className="race-teaser" aria-labelledby="race-title">
      <div className="race-copy">
        <span className="race-soon">Coming soon</span>
        <H id="race-title" className="race-title">One coin. One CA.<br /><em>Every chain.</em></H>
        <p className="race-lead">
          Launch once and your coin goes live on Uniswap on every chain at the same moment, with the same contract address.
          Then the chains race for five minutes, and the winner takes all the money into one deep pool.
        </p>
        <ul className="race-points">
          {POINTS.map(([t, d]) => (
            <li key={t}><strong>{t}</strong><span>{d}</span></li>
          ))}
        </ul>
        <div className="race-actions">
          <a href={X_URL} target="_blank" rel="noreferrer" className="race-btn">Follow @sasapadfun for launch day</a>
          <a href="/race/" className="race-link">How the race works</a>
        </div>
      </div>
      <div className="race-media">
        <video
          className="race-video"
          src="/race.mp4"
          poster="/race-poster.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="A coin launching on four chains at once and racing for five minutes"
        />
      </div>
    </section>
  );
}

/** Slim banner for the top of Explore. */
export function RaceBanner() {
  return (
    <a href="/race/" className="race-banner" aria-label="Coming soon: the five-minute race. See how it works">
      <div className="race-banner-text">
        <span className="race-soon">Coming soon</span>
        <strong>One coin. One CA. Every chain.</strong>
        <span className="race-banner-sub">Live on Uniswap everywhere at once, then a five-minute race. One winner.</span>
      </div>
      <RaceBars compact />
      <span className="race-banner-go">See how →</span>
    </a>
  );
}
