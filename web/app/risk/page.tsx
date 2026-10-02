import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = { title: "Risks · sasa", alternates: { canonical: "/risk/" } };

export default function Risk() {
  return (
    <LegalPage title="Risks">
      <p>
        <b>Meme coins are extremely risky. Only use money you can afford to lose completely.</b> Nothing on sasa is financial advice.
      </p>
      <ul>
        <li><b>Prices</b> can fall to zero in minutes. Most new coins never graduate, and most graduated coins lose value.</li>
        <li><b>Creators and big holders</b> can sell at any time, even if a coin looks safe. Safety checks only catch some warning signs.</li>
        <li><b>Smart contracts</b> can have bugs. sasa&apos;s contracts were independently reviewed (see <a href="/security/" className="text-emerald">Security</a>), but no review can prove there are no bugs, so money in them is limited at first.</li>
        <li><b>Blockchains and bridges</b> can be slow, congested or fail; moving money or coins between chains depends on third-party services.</li>
        <li><b>Graduation</b> pauses trading briefly while every chain is settled; prices can move when trading resumes.</li>
        <li><b>Slippage</b>: the price can change between your tap and the trade landing; your trade is cancelled if it moves more than your limit.</li>
        <li><b>Your account</b>: anyone with access to your email or device may be able to move your funds. Keep them secure.</li>
        <li><b>Mistakes are final</b>: blockchain transfers can&apos;t be undone. Check addresses and networks.</li>
        <li><b>Rules can change</b>: laws about crypto differ by country and change often.</li>
      </ul>
    </LegalPage>
  );
}
