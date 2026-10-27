import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = {
  title: "Terms of Service · sasa",
  description: "The terms for using sasa: who may use it, your wallet, the five-minute launch race, fees, and the limits of what sasa is responsible for.",
  alternates: { canonical: "/terms/" },
};

export default function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        These terms apply when you use sasa (sasapad.fun and its apps). By using sasa you agree to them. If you don&apos;t agree, don&apos;t use sasa.
      </p>

      <h2>1. What sasa is</h2>
      <p>
        sasa is software that lets people launch and trade crypto tokens (&quot;coins&quot;) through smart contracts on public blockchains, and buy and sell
        tokens listed on other decentralized exchanges. sasa is not a bank, broker, exchange operator or custodian, and does not give financial, investment,
        legal or tax advice.
      </p>

      <h2>2. Who may use sasa</h2>
      <ul>
        <li>You must be at least 18 and able to enter a binding agreement.</li>
        <li>
          You may not use sasa if you are in, or a resident or citizen of, the United States, or any country or region under comprehensive sanctions, or
          anywhere using sasa is against the law. You may not use a VPN or other tools to get around these limits.
        </li>
        <li>You may not use sasa if you are on a sanctions list, or on behalf of anyone who is.</li>
      </ul>

      <h2>3. Your wallet and your funds</h2>
      <p>
        sasa does not hold your money. Your funds sit in a wallet that only you control: either your own wallet, or a wallet created for you when you sign
        in with email or Google (provided by a third-party wallet service). You are responsible for keeping your login and devices safe. Blockchain
        transactions can&apos;t be reversed: funds sent to a wrong address or on a wrong network may be lost.
      </p>
      <p>
        Deposits and withdrawals in the sasa app are USDC on the Base network only. Sending any other token, or USDC on another network, may lose it.
        You pay the network fees of your transactions. With a wallet created for you, they are paid in USDC from your balance through a third-party
        service (Circle&apos;s paymaster); with your own wallet, in the chain&apos;s own coin.
      </p>

      <h2>4. Coins on sasa</h2>
      <p>
        Anyone can launch a coin. sasa does not review, endorse or guarantee any coin, its creator, or anything said about it. Meme coins usually have no
        purpose or value beyond what people will pay for them, and most lose all of their value. Prices, charts, safety checks and other information on sasa
        are provided as-is and may be wrong or delayed.
      </p>

      <h2>5. The launch race</h2>
      <p>
        A coin created on sasa launches on several chains (Base, BNB Chain, Robinhood Chain and Arc) with the same contract address, each with its own
        pool. For five minutes anyone can buy on any of them. Then the smart contracts compare each chain&apos;s money in dollars, using Chainlink prices,
        and the chain with the most money wins. The other chains&apos; pools close; their money is converted at the Chainlink price and moved into the
        winning pool, minus a hand-over fee; holders&apos; coins on those chains are moved to the winning chain. The winning pool is locked forever. These
        steps are carried out by the smart contracts and the services they use, and can be delayed by them. By buying a coin during a race you accept
        that it may end up on a different chain than the one you bought on.
      </p>

      <h2>6. Fees</h2>
      <ul>
        <li>Trading in a race coin&apos;s pool: 2% of each trade. 30% of it goes to the coin&apos;s creator (or buys back and burns the coin, if the creator chose that); 70% goes to sasa.</li>
        <li>Opening fee: right after launch the pool fee is higher and falls to 2% within the first few minutes.</li>
        <li>End of a race: 2% of the money moved from the losing pools into the winning pool.</li>
        <li>Coins from other exchanges: 1% per trade.</li>
        <li>Creating a coin: no sasa fee; the creator makes a first buy on each chain, which pays the trading fee.</li>
        <li>Deposits and withdrawals: no sasa fee.</li>
        <li>Network fees: paid by you, as described in section 3.</li>
      </ul>
      <p>Fees are taken automatically by the smart contracts or services involved and may change; the current fees are always shown here.</p>

      <h2>7. Third-party services</h2>
      <p>
        sasa relies on blockchains and on services run by others (for example wallet providers, LayerZero, Chainlink, Circle, Uniswap, PancakeSwap and data providers). sasa is not responsible for
        them, and their own terms apply.
      </p>

      <h2>8. Things you may not do</h2>
      <ul>
        <li>Break the law, including laws on fraud, market manipulation, money laundering and sanctions.</li>
        <li>Launch coins that impersonate others, infringe rights, or are made to deceive buyers.</li>
        <li>Attack, overload or try to exploit sasa, its contracts or its users.</li>
        <li>Post illegal, hateful or abusive content.</li>
      </ul>
      <p>sasa may hide coins, content or accounts in its interface, and may stop offering features, at its discretion.</p>

      <h2>9. No warranty</h2>
      <p>
        sasa is provided &quot;as is&quot; and &quot;as available&quot;. Smart contracts and software can have bugs, and blockchains can fail, be congested or
        change. You use sasa at your own risk.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, sasa and the people behind it are not liable for any indirect or consequential loss, or for any loss of funds,
        profits or data arising from your use of sasa, coins, smart contracts, blockchains or third-party services.
      </p>

      <h2>11. Taxes</h2>
      <p>You are responsible for any taxes on your activity.</p>

      <h2>12. Changes</h2>
      <p>These terms may change. The date at the top shows the latest version; using sasa after a change means you accept it.</p>

      <h2>13. Contact</h2>
      <p>
        Questions about these terms: write to us from the <a href="/help/" className="text-emerald">Help</a> page.
      </p>
    </LegalPage>
  );
}
