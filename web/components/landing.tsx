import { ARTICLES } from "@/lib/articles";

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
          <span>sasa</span>
        </a>
        <nav className="sasa-nav">
          <a href="/top/" className="sasa-learn">Top coins</a>
          <a href="/learn/" className="sasa-learn">Learn</a>
          <a href={X_URL} className="sasa-follow" target="_blank" rel="noreferrer">
          Follow on
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          </a>
        </nav>
      </header>

      <main className="sasa-main">
        <div className="sasa-status">
          <span className="sasa-dot" aria-hidden="true" />
          Testnet live · Mainnet coming soon
        </div>
        <h1>
          <span className="sasa-nowrap">No wallet.</span> <span className="sasa-nowrap">No gas.</span>
          <br />
          <span className="sasa-nowrap">No bridge.</span> <em className="sasa-nowrap">Just buy.</em>
        </h1>
        <p className="sasa-lead">
          sasa launches your coin on every chain at the same time. Buyers everywhere push it toward one shared finish
          line, and the chain with the most support wins.
        </p>
        <div className="sasa-actions">
          <a href={X_URL} className="sasa-btn" target="_blank" rel="noreferrer">
            Follow @sasapadfun
          </a>
        </div>
        <ul className="sasa-chains" aria-label="Chains">
          {CHAINS.map((c) => (
            <li key={c.name}>
              <span style={{ background: c.color }} aria-hidden="true" />
              {c.name}
            </li>
          ))}
        </ul>
      </main>

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
          {ARTICLES.map((a) => (
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
