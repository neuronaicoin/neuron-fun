import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = {
  title: "Risks · sasa",
  description: "The risks of meme coins and of sasa's launch race: prices, the five-minute race, fees, smart contracts, other chains and your account.",
  alternates: { canonical: "/risk/" },
};

export default function Risk() {
  return (
    <LegalPage title="Risks">
      <p>
        <b>Meme coins are extremely risky. Only use money you can afford to lose completely.</b> Nothing on sasa is financial advice.
      </p>
      <ul>
        <li><b>Prices</b> can fall to zero in minutes. Most new coins lose most or all of their value.</li>
        <li><b>Creators and big holders</b> can sell at any time. Creators&apos; coins are not locked. Safety checks only catch some warning signs.</li>
        <li><b>The race</b>: if the chain you bought on loses, its pool closes and your coins are moved to the winning chain, where the price can be different from what you paid.</li>
        <li><b>Hand-over fee</b>: when a race ends, 2% of the losing pools&apos; money is taken as a fee before the rest goes into the winner&apos;s pool.</li>
        <li><b>Opening fee</b>: right after launch the pool fee is higher than 2% and falls to 2% within the first few minutes. Buying in that window costs more.</li>
        <li><b>Prices between chains</b> are compared with Chainlink price feeds. If a feed is late or wrong, a race result or a conversion can be affected.</li>
        <li><b>Smart contracts</b> can have bugs. The race contracts&apos; independent review is still to come; see <a href="/security/" className="text-emerald">Security</a>.</li>
        <li><b>Other chains and services</b> (LayerZero, Chainlink, the DEXs, Circle) can be slow, congested or fail.</li>
        <li><b>Slippage</b>: the price can change between your tap and the trade landing; your trade is cancelled if it moves more than your limit.</li>
        <li><b>Your account</b>: anyone with access to your email or device may be able to move your funds. Keep them secure.</li>
        <li><b>Mistakes are final</b>: blockchain transfers can&apos;t be undone. Deposit only USDC on the Base network, and check addresses and networks.</li>
        <li><b>Rules can change</b>: laws about crypto differ by country and change often.</li>
      </ul>
    </LegalPage>
  );
}
