import Link from "next/link";

export const metadata = { title: "How it works — Neuron.fun" };

const FAQ: [string, string][] = [
  [
    "What does \"launch once, live on every chain\" mean?",
    "When you create a coin you pick the chains it launches on. It appears on all of them at the same time, with the same name and picture, and people can buy it on whichever chain they already use.",
  ],
  [
    "How does graduation work?",
    "Every chain has its own price curve, but the money people put in is added up across all chains, in dollars. When the total reaches the target, the coin graduates. The chain holding the most money wins: its money goes into a trading pool that is locked forever, and the coin carries on there.",
  ],
  [
    "What happens on the chains that didn't win?",
    "Buying stops there, but selling back stays open forever, so nobody's money is stuck. Holders can get their money back in one tap, and move it to the winning chain with a bridge if they want to keep holding the coin.",
  ],
  [
    "Who decides when a coin graduates?",
    "A bot adds up the chains and triggers graduation. It can only graduate or close; the contracts don't let it move anyone's money. Every decision comes with a published report of the numbers, so anyone can check it.",
  ],
  [
    "Where do the fees go?",
    "Every buy and sell pays 1%. 0.3% goes to the coin's creator and 0.7% keeps the platform running. The same split applies in the locked pool after graduation.",
  ],
  [
    "Can the creator run off with the money?",
    "No. Before graduation the money sits in the price curve, where only sellers can take it out by selling. After graduation it is locked in the pool forever. The creator can sell coins they bought, like anyone else.",
  ],
  [
    "Do you hold my money?",
    "Never. Every action is a transaction you sign in your own wallet.",
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
        Neuron.fun launches a meme coin on several chains at once. Buyers on every chain push it toward one shared
        target, and the chain with the most money wins.
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
