import Link from "next/link";

export const metadata = {
  title: "How it works · sasa",
  description: "How sasa's five-minute launch race works: one coin on Base, BNB Chain, Robinhood Chain and Arc at once, one winner, liquidity locked forever.",
  alternates: { canonical: "/how-it-works/" },
};

const FAQ: [string, string][] = [
  [
    "What does \"launch once, live on every chain\" mean?",
    "When you create a coin it goes live on Base, BNB Chain, Robinhood Chain and Arc within seconds, with the same name, picture and contract address everywhere. Each chain gets its own pool on a real DEX (Uniswap or PancakeSwap), so the coin shows on DexScreener and trading bots from the first trade.",
  ],
  [
    "What is the five-minute race?",
    "For five minutes anyone can buy the coin on any of its chains. Every chain's money is counted in dollars with Chainlink prices. When time is up, the chain with the most money wins.",
  ],
  [
    "What happens on the chains that lose?",
    "Their pools close. Their money is converted at the Chainlink price and moved into the winner's pool, minus a 2% hand-over fee. Everyone's coins on those chains are moved to the winning chain automatically: nothing to claim, nothing to bridge.",
  ],
  [
    "Can anyone pull the liquidity?",
    "No. The winning pool is locked forever by the contracts. Not the creator, not sasa, nobody can take that money out. The creator's own coins are not locked: they can sell like anyone else, and their buys are labeled in the trades list.",
  ],
  [
    "Where do the fees go?",
    "Every trade in a race coin's pool pays 2%. 30% of that goes to the coin's creator, forever, or to buybacks that burn the coin if the creator picked buyback and burn. The other 70% keeps sasa running. Right after launch the fee starts higher and falls to 2% within the first few minutes, to slow down sniper bots.",
  ],
  [
    "What does it cost to launch?",
    "A first buy on each chain in USDC (we recommend $5 or more per chain) plus a few cents of network fees per chain.",
  ],
  [
    "Do you hold my money?",
    "No. Every action is a transaction signed by your own wallet. If you sign in with email or Google, a wallet is created for you that only you control. Deposits and withdrawals are USDC on the Base network.",
  ],
  [
    "Is this safe?",
    "Meme coins are very risky and most lose their value. The contracts lock the winning pool and limit what anyone can do, but no code is free of risk. Read the Risks and Security pages, and only use money you can afford to lose.",
  ],
];

const ld = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
};

export default function HowItWorks() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} />
      <h1 className="font-display font-semibold text-[2.125rem] sm:text-[2.875rem] tracking-tight leading-tight">How it works</h1>
      <p className="text-[1.125rem] text-ink-2 mt-4 leading-relaxed">
        sasa launches a meme coin on four chains at once. For five minutes buyers on every chain push their chain ahead, and the chain with the most
        money wins and keeps the coin, with its pool locked forever.
      </p>

      <div className="mt-10 grid gap-3">
        {FAQ.map(([q, a]) => (
          <details key={q} className="group bg-surface border border-line rounded-2xl p-5 open:border-emerald">
            <summary className="flex items-center justify-between gap-4 cursor-pointer list-none font-semibold text-[1.0625rem]">
              {q}
              <span className="text-emerald text-[1.375rem] leading-none transition-transform group-open:rotate-45" aria-hidden="true">
                +
              </span>
            </summary>
            <p className="text-[1rem] text-ink-2 mt-3 leading-relaxed">{a}</p>
          </details>
        ))}
      </div>

      <p className="mt-6 text-[0.9375rem] text-ink-2">
        More detail: <Link href="/race/" className="text-emerald font-semibold">the launch race</Link>,{" "}
        <Link href="/risk/" className="text-emerald font-semibold">Risks</Link> and{" "}
        <Link href="/security/" className="text-emerald font-semibold">Security</Link>.
      </p>

      <div className="mt-10 bg-night text-ink rounded-3xl p-7 text-center">
        <h2 className="font-display font-semibold text-[1.5rem]">Ready?</h2>
        <p className="text-ink-2 mt-2">It takes about a minute.</p>
        <Link href="/race/launch/" className="inline-flex mt-5 h-12 px-7 rounded-xl bg-emerald text-on-accent font-semibold items-center">
          Create a coin
        </Link>
      </div>
    </div>
  );
}
