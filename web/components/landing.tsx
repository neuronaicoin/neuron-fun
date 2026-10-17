import { ARTICLES } from "@/lib/articles";
import { RaceTeaser } from "@/components/racepromo";
import { IS_TESTNET } from "@/lib/config";

/**
 * Pre-launch page shown on sasapad.fun (see the host check in layout.tsx).
 * Plain markup, no data: it must load instantly and say only what is true.
 */
const X_URL = "https://x.com/sasapadfun";

export function SasaMark({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="24" fill="#1A130D" />
      <path d="M26 60 L50 38 L74 60" fill="none" stroke="#FFB020" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M26 80 L50 58 L74 80" fill="none" stroke="#FF6B1A" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="22" r="6" fill="#FFB020" />
    </svg>
  );
}

/** The "sasa" wordmark: the dark half follows the text color (currentColor), the second half is brand orange. */
export function SasaWordmark({ height = 18, className = "" }: { height?: number; className?: string }) {
  return (
    <svg height={height} width={Math.round(height * 3.6137)} viewBox="15 -574 2161 598" role="img" aria-label="sasa" className={className}>
      <g transform="matrix(1,0,0.2,-1,0,0)"><path d="M253.0 -18.0Q133.0 -18.0 64.0 31.5Q-5.0 81.0 -10.0 171.0H150.0Q154.0 146.0 181.0 128.0Q208.0 110.0 257.0 110.0Q292.0 110.0 317.5 120.5Q343.0 131.0 343.0 155.0Q343.0 176.0 323.0 189.5Q303.0 203.0 250.0 208.0L212.0 212.0Q106.0 223.0 56.0 270.0Q6.0 317.0 6.0 388.0Q6.0 449.0 36.0 488.5Q66.0 528.0 119.0 548.0Q172.0 568.0 240.0 568.0Q351.0 568.0 419.0 519.5Q487.0 471.0 491.0 380.0H331.0Q327.0 405.0 304.0 422.5Q281.0 440.0 238.0 440.0Q207.0 440.0 187.5 429.0Q168.0 418.0 168.0 398.0Q168.0 377.0 186.5 367.0Q205.0 357.0 246.0 352.0L284.0 348.0Q390.0 337.0 447.5 289.5Q505.0 242.0 505.0 165.0Q505.0 108.0 474.5 67.0Q444.0 26.0 387.5 4.0Q331.0 -18.0 253.0 -18.0Z" fill="currentColor" /><path d="M605,440 C645,490 705,500 785,500 C905,500 955,450 955,360 M955,380 L955,0 M955,290 L765,290 C655,290 595,240 595,170 C595,95 655,60 755,60 C865,60 945,110 955,200" stroke="currentColor" fill="none" strokeWidth="124" strokeLinejoin="round" /><path d="M1328.0 -18.0Q1208.0 -18.0 1139.0 31.5Q1070.0 81.0 1065.0 171.0H1225.0Q1229.0 146.0 1256.0 128.0Q1283.0 110.0 1332.0 110.0Q1367.0 110.0 1392.5 120.5Q1418.0 131.0 1418.0 155.0Q1418.0 176.0 1398.0 189.5Q1378.0 203.0 1325.0 208.0L1287.0 212.0Q1181.0 223.0 1131.0 270.0Q1081.0 317.0 1081.0 388.0Q1081.0 449.0 1111.0 488.5Q1141.0 528.0 1194.0 548.0Q1247.0 568.0 1315.0 568.0Q1426.0 568.0 1494.0 519.5Q1562.0 471.0 1566.0 380.0H1406.0Q1402.0 405.0 1379.0 422.5Q1356.0 440.0 1313.0 440.0Q1282.0 440.0 1262.5 429.0Q1243.0 418.0 1243.0 398.0Q1243.0 377.0 1261.5 367.0Q1280.0 357.0 1321.0 352.0L1359.0 348.0Q1465.0 337.0 1522.5 289.5Q1580.0 242.0 1580.0 165.0Q1580.0 108.0 1549.5 67.0Q1519.0 26.0 1462.5 4.0Q1406.0 -18.0 1328.0 -18.0Z" fill="#FF6B1A" /><path d="M1680,440 C1720,490 1780,500 1860,500 C1980,500 2030,450 2030,360 M2030,380 L2030,0 M2030,290 L1840,290 C1730,290 1670,240 1670,170 C1670,95 1730,60 1830,60 C1940,60 2020,110 2030,200" stroke="#FF6B1A" fill="none" strokeWidth="124" strokeLinejoin="round" /></g>
    </svg>
  );
}

const CHAINS = [
  { name: "Robinhood", color: "#12B886" },
  { name: "Base", color: "#3B6FF5" },
  { name: "More soon", color: "#6E5F53" },
];

export function Landing() {
  return (
    <div className="sasa-landing">
      <div className="sasa-glow" aria-hidden="true" />
      <header className="sasa-top">
        <a href="/" className="sasa-brand" aria-label="sasa home">
          <SasaMark size={40} />
          <SasaWordmark height={25} />
        </a>
        <nav className="sasa-nav">
          <a href="/explore/" className="sasa-learn">Explore</a>
          <a href="/race/launch/" className="sasa-learn">Create</a>
          <a href="/learn/" className="sasa-learn sasa-hide-s">Learn</a>
          <a href={X_URL} className="sasa-follow" target="_blank" rel="noreferrer">
          <span className="sasa-follow-t">Follow on</span>
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          </a>
        </nav>
      </header>

      <main className="sasa-main sasa-hero">
        <div className="sasa-hero-text">
        <div className="sasa-status">
          <span className="sasa-dot" aria-hidden="true" />
          {IS_TESTNET ? "Testnet live · Mainnet coming soon" : "Live now on Base, BNB Chain, Robinhood Chain and Arc"}
        </div>
        <h1>
          <span className="sasa-nowrap">No wallet.</span> <span className="sasa-nowrap">No bridge.</span>
          <br />
          <span className="sasa-nowrap">No bridge.</span> <em className="sasa-nowrap">Just buy.</em>
        </h1>
        <p className="sasa-lead">
          sasa launches your coin on every chain at the same time. Buyers everywhere push it toward one shared finish
          line, and the chain with the most support wins.
        </p>
        <div className="sasa-actions">
          <a href="/explore/" className="sasa-btn">Trade coins</a>
          <a href="/race/launch/" className="sasa-btn sasa-btn-2">Create a coin</a>
        </div>
        <ul className="sasa-chains" aria-label="Chains">
          {CHAINS.map((c) => (
            <li key={c.name}>
              <span style={{ background: c.color }} aria-hidden="true" />
              {c.name}
            </li>
          ))}
        </ul>
        </div>
        <a href="/race/launch/" className="sasa-hero-art" aria-label="Create a coin or trade one on sasa">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/hero-phones.png" alt="sasa on a phone: the Create a coin screen and a Buy screen" width={560} height={620} />
        </a>
      </main>

      <RaceTeaser />

      <section className="sasa-steps" aria-label="How it works">
        {[
          ["01", "Launch once", "One form puts your coin live on every chain at the same moment."],
          ["02", "Everyone pushes", "Buys on every chain add up to one progress bar toward graduation."],
          ["03", "One winner", "At the target, the strongest chain wins and liquidity is locked forever."],
        ].map(([n, t, d]) => (
          <div key={n} className="sasa-step">
            <span>{n}</span>
            <h2>{t}</h2>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="sasa-guides" aria-labelledby="guides">
        <h2 id="guides">Guides</h2>
        <div className="sasa-guide-grid">
          {ARTICLES.slice(0, 6).map((a) => (
            <a key={a.slug} href={`/learn/${a.slug}/`} className="sasa-guide">
              <strong>{a.title}</strong>
              <span>{a.summary}</span>
            </a>
          ))}
        </div>
        <a href="/learn/" className="sasa-all">All guides →</a>
      </section>

      <footer className="sasa-foot">
        <span>© {new Date().getFullYear()} sasa</span>
        <span>Meme coins are risky. Nothing here is financial advice.</span>
      </footer>
    </div>
  );
}
