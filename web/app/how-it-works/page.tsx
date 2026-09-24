import Link from "next/link";

export const metadata = { title: "How it works — Neuron.fun" };

const FAQ: [string, string][] = [
  [
    "What is a family coin?",
    "When you create a coin, you pick an existing coin as its family. From then on, part of every trade on your coin is used to buy the family coin and burn it. Burned coins are gone forever, so there are fewer of them left.",
  ],
  [
    "Why would I pick a family?",
    "Your coin gets noticed by the family's community from day one. People who hold the family coin have a reason to like your coin, because it keeps burning theirs.",
  ],
  [
    "Where do the fees go?",
    "Every buy and sell pays 1%. Of that, 0.3% buys and burns the family coin, 0.3% goes to the coin's creator, and 0.4% keeps the platform running.",
  ],
  [
    "Can the creator run off with the money?",
    "The money pool of every coin is locked forever when the coin is created. Nobody can take it out, not the creator and not us. The creator can still sell coins they bought, like anyone else.",
  ],
  [
    "Does a falling family coin hurt my coin?",
    "No. Your coin is traded with ETH, not with the family coin. The family only benefits from your coin; it can't drag it down.",
  ],
  [
    "Do you hold my money?",
    "Never. Every action is a transaction you sign in your own wallet. Neuron.fun is a set of public contracts; anyone can check every burn and every fee on the blockchain.",
  ],
  [
    "Is this safe?",
    "Meme coins are very risky and most lose their value. The contracts are tested, but they have not been through an independent security audit yet. Only use money you can afford to lose.",
  ],
];

export default function HowItWorks() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <h1 className="font-display font-semibold text-[34px] sm:text-[46px] tracking-tight leading-tight">How it works</h1>
      <p className="text-[18px] text-ink-2 mt-4 leading-relaxed">
        Neuron.fun is a place to create meme coins. The difference: every coin belongs to a family, and every trade
        makes that family stronger.
      </p>

      <div className="mt-10 grid gap-3">
        {FAQ.map(([q, a]) => (
          <details key={q} className="group bg-white border border-line rounded-2xl p-5 open:border-emerald">
            <summary className="flex items-center justify-between gap-4 cursor-pointer list-none font-semibold text-[17px]">
              {q}
              <span className="text-emerald text-[22px] leading-none transition-transform group-open:rotate-45" aria-hidden="true">+</span>
            </summary>
            <p className="text-[16px] text-ink-2 mt-3 leading-relaxed">{a}</p>
          </details>
        ))}
      </div>

      <div className="mt-10 bg-night text-mist rounded-3xl p-7 text-center">
        <h2 className="font-display font-semibold text-[24px]">Ready?</h2>
        <p className="text-[#a9bab3] mt-2">It takes about a minute.</p>
        <Link href="/create/" className="inline-flex mt-5 h-12 px-7 rounded-xl bg-mint text-ink font-semibold items-center">
          Create a coin
        </Link>
      </div>
    </div>
  );
}
