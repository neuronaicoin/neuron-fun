import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = {
  title: "Security · sasa",
  description: "How sasa's smart contracts were reviewed: three rounds of independent review, findings and how each was resolved.",
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
        <p className="font-display font-bold text-[1.125rem] text-ink">Independently reviewed</p>
        <p className="mt-1">
          sasa&apos;s smart contracts went through <b>three rounds of independent review</b>. No critical, high or open medium findings remain; the
          reviewer found the code ready for production after the final round.
        </p>
        <a href="/security-review.pdf" target="_blank" rel="noopener" className="inline-flex mt-3 h-11 px-4 rounded-xl bg-ink text-paper font-bold items-center">
          Read the review (PDF)
        </a>
      </div>

      <h2>What was reviewed</h2>
      <p>
        About 2,100 lines of Solidity: the contracts that launch coins on every chain, run the bonding curves, decide the winning chain, move money
        between chains, open the locked Uniswap pools, and run auto orders. Code version: commit <code className="font-mono text-[0.8125rem] break-all">bdb63168</code>{" "}
        with the round 2 and 3 fixes.
      </p>

      <h2>Findings and how they were resolved</h2>
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
        <li>A coin&apos;s supply can never exceed 1,000,000,000 across all chains.</li>
        <li>Pool liquidity is locked forever.</li>
        <li>The winning chain is decided by on-chain math from every chain&apos;s report.</li>
        <li>Fees have hard caps in the contracts, and selling can never be paused.</li>
      </ul>

      <h2>Remaining risks</h2>
      <ul>
        <li>sasa depends on LayerZero, Across, Uniswap v4 and the issuers of USDC and USDG.</li>
        <li>Money held by the launch curves is capped per chain at first and raised gradually.</li>
        <li>A review lowers risk but can&apos;t prove there are no bugs. Meme coins themselves are very risky; see <a href="/risk/" className="text-emerald">Risks</a>.</li>
      </ul>
      <p className="text-[0.8125rem] text-ink-3">
        The review document is written and published by sasa; it summarizes the independent review in our own words and is not a certificate issued by
        the reviewer.
      </p>
    </LegalPage>
  );
}
