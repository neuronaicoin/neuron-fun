import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = {
  title: "Security · sasa",
  description: "How sasa's smart contracts are secured: the independent review of the multi-chain contracts, the launch race contracts, and what the code guarantees.",
  alternates: { canonical: "/security/" },
};

const FINDINGS: [string, string, string, string][] = [
  ["M-1", "Medium", "After graduation anyone could move a holder's coins to the winning chain at a moment the holder didn't choose.", "Fixed: for 24 hours only sasa's keeper moves other holders; each holder can move their own coins any time; after 24 hours anyone may, so coins never get stuck."],
  ["M-2", "Medium", "If the bridge ever refunded less than a deposit, that money couldn't be re-sent.", "Fixed: the refunded amount can be re-sent once, only to the same coin and chain."],
  ["L-1", "Low", "Rounding dust could stay in a settled curve.", "Fixed: anything left over goes to the protocol fee at settlement."],
  ["L-2", "Low", "Extra money arriving at graduation opens the pool slightly above the graduation price.", "Accepted: it only benefits holders."],
  ["L-3", "Low", "An order's upper limit is checked after the trade.", "Accepted: a failing check undoes the whole trade."],
  ["L-4", "Low", "If the keeper stops, the public freeze could be repeated.", "Accepted: only when the keeper is down; harmless; monitored."],
  ["Info", "Info", "Some admin changes emitted no events.", "Fixed: events added."],
];

export default function Security() {
  return (
    <LegalPage title="Security">
      <div className="rounded-2xl border border-up/40 bg-up/10 p-4">
        <p className="font-display font-bold text-[1.125rem] text-ink">Core contracts independently reviewed</p>
        <p className="mt-1">
          sasa&apos;s multi-chain core (the contracts that launch a coin on every chain with one address and decide the winning chain) went through{" "}
          <b>three rounds of independent review</b>. No critical, high or open medium findings remain.
        </p>
        <a href="/security-review.pdf" target="_blank" rel="noopener" className="inline-flex mt-3 h-11 px-4 rounded-xl bg-ink text-paper font-bold items-center">
          Read the review (PDF)
        </a>
      </div>

      <h2>The launch race contracts</h2>
      <p>
        The five-minute race is built on that reviewed core: the same hub counts every chain&apos;s money and decides the winner. New contracts open each
        chain&apos;s pool (Uniswap v4 on Base and Robinhood Chain, PancakeSwap Infinity on BNB Chain, a USDC pool on Arc), run the launch fee, and move the
        losing pools&apos; money and holders to the winner. These race contracts have been tested end to end on the testnets of all four chains;{" "}
        <b>their independent review is still to come</b>, and we will publish it here.
      </p>

      <h2>What the review covered</h2>
      <p>
        The review was done on sasa&apos;s first multi-chain version, which launched coins on bonding curves; the race keeps its core (one address on
        every chain, the hub that decides the winner). About 2,100 lines of Solidity: the contracts that launch coins on every chain, run the bonding curves, decide the winning chain, move money
        between chains, open the locked Uniswap pools, and run auto orders. Code version: commit <code className="font-mono text-[0.8125rem] break-all">bdb63168</code>{" "}
        with the round 2 and 3 fixes.
      </p>

      <h2>Findings in that review and how they were resolved</h2>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full text-[0.8125rem]">
          <thead className="bg-paper text-ink">
            <tr>
              <th className="text-left p-2.5">ID</th>
              <th className="text-left p-2.5">Severity</th>
              <th className="text-left p-2.5 min-w-[12rem]">Finding</th>
              <th className="text-left p-2.5 min-w-[14rem]">Resolution</th>
            </tr>
          </thead>
          <tbody>
            {FINDINGS.map(([id, sev, f, r]) => (
              <tr key={id} className="border-t border-line align-top">
                <td className="p-2.5 font-mono">{id}</td>
                <td className={"p-2.5 font-semibold " + (sev === "Medium" ? "text-warn-ink" : "text-ink-3")}>{sev}</td>
                <td className="p-2.5">{f}</td>
                <td className="p-2.5">{r}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>What the contracts guarantee</h2>
      <ul>
        <li>Money can only end up in a coin&apos;s own locked pool, as the published fees, or burned through buybacks. No admin can take it.</li>
        <li>A coin&apos;s supply can never exceed 1,000,000,000 across all chains, and it has the same address on every chain.</li>
        <li>The winning pool&apos;s liquidity is locked forever.</li>
        <li>The winning chain is decided by on-chain math from every chain&apos;s report, with dollar values from Chainlink prices.</li>
        <li>Holders on the losing chains are moved to the winning chain automatically; nobody has to claim anything.</li>
        <li>Fees are fixed in the contracts: 2% per trade after the opening minutes, 30% of it to the creator.</li>
      </ul>

      <h2>Remaining risks</h2>
      <ul>
        <li>sasa depends on LayerZero (messages between chains), Chainlink (prices), Uniswap v4, PancakeSwap Infinity and Circle (USDC).</li>
        <li>The race contracts&apos; independent review is still to come (see above).</li>
        <li>A review lowers risk but can&apos;t prove there are no bugs. Meme coins themselves are very risky; see <a href="/risk/" className="text-emerald">Risks</a>.</li>
      </ul>
      <p className="text-[0.8125rem] text-ink-3">
        The review document is written and published by sasa; it summarizes the independent review in our own words and is not a certificate issued by
        the reviewer.
      </p>
    </LegalPage>
  );
}
