import type { Metadata } from "next";
import { LegalPage } from "@/components/legal";

export const metadata: Metadata = { title: "Privacy · sasa", alternates: { canonical: "/privacy/" } };

export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>This explains what sasa collects and why. sasa keeps as little as it can.</p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Wallet address</b> and your public on-chain activity (trades, launches). This is public on the blockchain anyway.</li>
        <li><b>Sign-in details</b> if you sign in with email or Google: handled by our wallet provider; we receive your wallet address and, for email sign-in, your email.</li>
        <li><b>What you choose to add</b>: profile name, picture, bio, links, comments, forum posts, watchlist, alerts and messages to support.</li>
        <li><b>Basic usage data</b>: pages visited, device type and how you found sasa, measured with Google Analytics with its advertising features turned off, to keep sasa working and improve it. In the EU, UK and Switzerland it sets no analytics cookies.</li>
        <li><b>Push notifications</b>: if you turn them on, a technical address your browser gives us to send them.</li>
      </ul>

      <h2>What we don&apos;t do</h2>
      <ul>
        <li>We never see or store your private keys.</li>
        <li>We don&apos;t sell your data or show ads.</li>
      </ul>

      <h2>Who helps us run sasa</h2>
      <p>
        Hosting, database, wallet sign-in, gas sponsorship, email, analytics (Google Analytics) and blockchain data providers process data for us so sasa
        can work. They may be in other countries.
      </p>

      <h2>Your choices</h2>
      <p>
        You can edit or remove your profile, comments and alerts, turn off notifications, and ask us to delete what we hold about you through the Help page.
        What is on a blockchain can&apos;t be deleted by anyone.
      </p>

      <h2>Changes</h2>
      <p>We may update this page; the date at the top shows the latest version.</p>
    </LegalPage>
  );
}
