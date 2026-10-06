/**
 * Guides for sasapad.fun/learn. Plain data so pages stay static and fast.
 * Keep every claim true today; update when mainnet or fees change.
 */
import { MORE_ARTICLES } from "./articles-more";
import { NEW_ARTICLES } from "./articles-new";

export type Block =
  | { h2: string }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { tip: string }
  /** An interactive tool placed in the article. */
  | { widget: "curve-sim" };

export type Article = {
  slug: string;
  title: string;
  description: string;
  date: string; // ISO
  updated: string;
  readMin: number;
  summary: string;
  body: Block[];
  faq: { q: string; a: string }[];
  /** 3-5 one-line answers shown first ("In short"): what search and AI engines quote. */
  takeaways?: string[];
  /** Topics, used to pick related reading. */
  tags?: string[];
};

const BASE_ARTICLES: Article[] = [
  {
    slug: "how-to-launch-a-meme-coin-on-robinhood-chain",
    title: "How to launch a meme coin on Robinhood Chain",
    description:
      "A step-by-step guide to launching a meme coin on Robinhood Chain: what you need, what it costs, how the launch works and how to keep your holders safe.",
    date: "2026-09-27",
    updated: "2026-10-01",
    readMin: 6,
    summary: "What you need, what it costs and every step from idea to live coin, without writing a line of code.",
    tags: ["launch", "robinhood-chain", "beginner"],
    takeaways: [
      "You can launch a meme coin on Robinhood Chain without code: a name, a ticker and a picture are enough.",
      "On sasa the launch is free; you only choose how much of your own coin to buy, in USDC.",
      "New coins start on a [bonding curve](/learn/what-is-a-bonding-curve/) and graduate to a locked Uniswap pool.",
      "You can launch on [several chains at once](/learn/multi-chain-token-launch/) with one shared graduation target.",
    ],
    body: [
      { p: "Robinhood Chain is an Ethereum layer 2 network, so fees are paid in ETH and are usually a small fraction of a dollar. That makes it one of the cheapest places to launch a meme coin, and one of the busiest: new tokens appear there every day. This guide walks through the whole process, from the wallet you need to the moment your coin is live." },
      { h2: "What you need before you start" },
      { ul: [
        "A wallet that supports custom networks, such as MetaMask, Rabby or Coinbase Wallet. Mobile wallets connect through WalletConnect.",
        "On sasa: an email address is enough. Your account is created for you, everything is priced in USDC and network fees are covered. With your own wallet, keep a little ETH on Robinhood Chain for network fees.",
        "A name, a short ticker (for example $HCAT) and a square picture. That is all a launch needs.",
      ] },
      { h2: "Step by step" },
      { ol: [
        "Open a launchpad and connect your wallet. The wallet will ask to add Robinhood Chain if it doesn't know it yet.",
        "Enter the name, ticker and picture. A short description helps people understand the idea.",
        "Choose whether to buy some of your own coin at launch. On sasa this first buy lands in the same transaction as the launch, so nobody can buy in before you.",
        "Confirm in your wallet. A few seconds later the coin exists and anyone can trade it.",
        "Share the link. Every new coin starts with zero attention, so the first hour matters most.",
      ] },
      { h2: "How the price works after launch" },
      { p: "Most meme launchpads, including sasa, sell new coins from a bonding curve: a formula that raises the price a little with every buy and lowers it with every sell. Nobody has to provide liquidity up front, and anyone can sell back at any time. When enough money has gone in, the coin graduates: the money and part of the supply move into a normal trading pool, and that pool is locked so it can never be pulled." },
      { tip: "Look for three things before you launch anywhere: a fixed supply, no owner who can mint more, and liquidity that is locked at graduation. Together they make a rug pull impossible by design." },
      { h2: "Launching on more than one chain" },
      { p: "Launching only on Robinhood Chain means only people with funds there can buy. On sasa you can pick several chains at once; the coin goes live on each of them in the same launch, and buys on every chain count toward one shared graduation target. The chain that attracts the most money wins, and the coin carries on there. You can read how that works in the multi-chain guide." },
      { h2: "What it costs" },
      { ul: [
        "Network fees: usually cents on Robinhood Chain, and covered for you when you sign in with email on sasa.",
        "Launch fee on sasa: none. You only pay the network fee.",
        "Trading fee: 1% of every trade. On sasa 0.3% of each trade goes to the coin's creator, which rewards you for building a community around it.",
      ] },
      { h2: "After the launch" },
      { p: "The launch is the easy part. Coins that do well usually have a clear idea, an active community on X or Telegram and a creator who stays around. Post updates, answer questions and never promise returns: meme coins are speculative and most lose their value." },
    ],
    faq: [
      { q: "Do I need to write code to launch a meme coin on Robinhood Chain?", a: "No. A launchpad handles the contract for you. You enter a name, ticker and picture and confirm one transaction in your wallet." },
      { q: "How much does it cost?", a: "On sasa there is no launch fee; you only pay the network fee, which is usually a few cents on Robinhood Chain. If you choose to buy some of your own coin, that amount comes on top." },
      { q: "Can I launch the same coin on Robinhood Chain and Base at the same time?", a: "Yes, on sasa. You pick the chains and the coin goes live on all of them in one launch, with one shared graduation target." },
      { q: "Is sasa live on mainnet?", a: "sasa is live on testnet today and mainnet is coming soon. Follow @sasapadfun on X for the launch date." },
    ],
  },
  {
    slug: "what-is-a-bonding-curve",
    title: "What is a bonding curve? Meme coin pricing explained",
    description:
      "How bonding curves price meme coins, why the price rises with every buy, what graduation means and why you can always sell back before it.",
    date: "2026-09-27",
    updated: "2026-10-01",
    readMin: 5,
    summary: "Why the price rises with every buy, why you can always sell back, and what happens at graduation.",
    tags: ["bonding-curve", "graduation", "beginner"],
    takeaways: [
      "A bonding curve is a price formula in a smart contract: each buy raises the price, each sell lowers it.",
      "You can always sell back to the curve before graduation, because it holds every buyer's money.",
      "At graduation the curve's money becomes a trading pool that is locked forever. More in [meme coin graduation](/learn/meme-coin-graduation-explained/).",
    ],
    body: [
      { p: "A bonding curve is a price formula written into a smart contract. Instead of waiting for someone to put up liquidity, the contract itself sells the coin: every buy pushes the price up a little, every sell pushes it down. It is the engine behind almost every modern meme coin launchpad." },
      { h2: "How the price moves" },
      { p: "The most common design uses two virtual reserves, one of money (USDC on sasa) and one of the coin, whose product stays constant. When you buy, money goes into the reserve and coins come out, so the next coin costs a little more. When you sell, the opposite happens. The formula is public and the same for everyone, so the price at any moment follows directly from how much has been bought and sold." },
      { ul: [
        "Early buyers pay less per coin than later buyers.",
        "Big buys move the price more than small ones.",
        "The price you see is the price you get, minus the fee and any movement while your transaction lands.",
      ] },
      { h2: "Why you can always sell back" },
      { p: "Because the curve holds all the money that buyers paid in, it can always pay out a seller according to the same formula. There is no order book that can run dry. On sasa this is guaranteed by the contract: until graduation, anyone can sell back at any time, and the curve always holds enough to buy every coin back." },
      { h2: "What graduation means" },
      { p: "A curve is a starting point, not a permanent home. Once a set amount of money has gone in, the coin graduates: the money in the curve and a matching amount of coins become a regular trading pool on a decentralised exchange, at the same price the curve reached. On sasa that pool is locked forever, so the liquidity can never be removed." },
      { tip: "Graduation is a milestone the whole community can see. A progress bar toward it is one of the clearest signals of how much real money a coin has attracted." },
      { h2: "Fees" },
      { p: "Every buy and sell on a curve pays a small fee. On sasa it is 1%: 0.3% goes to the coin's creator and 0.7% to the platform. The same split continues in the locked pool after graduation." },
      { h2: "Bonding curves across several chains" },
      { p: "On sasa a coin can launch on several chains at once, each with its own curve. Buys on every chain add up to one graduation target. When it is reached, the curve holding the most money graduates, the others stop taking buys, and holders there can still sell back whenever they like." },
    ],
    faq: [
      { q: "Is a bonding curve safe?", a: "The formula itself is simple and transparent. What matters is the contract around it: a fixed supply, no owner who can take the funds, and a guaranteed sell-back until graduation. sasa's contracts are built that way and will be independently audited before mainnet." },
      { q: "Why does my buy get fewer coins than the quote said?", a: "If others buy just before you, the price moves. sasa cancels a trade automatically if the price moves more than 5% while it is confirming, so you never pay more than you agreed to." },
      { q: "What happens to my coins at graduation?", a: "Nothing changes for holders: your coins stay in your wallet and now trade in the locked pool instead of on the curve." },
    ],
  },
  {
    slug: "multi-chain-token-launch",
    title: "How to launch a token on multiple chains at once",
    description:
      "Launch one coin on Robinhood Chain, Base and more in one step: how multi-chain launches work and how the shared graduation race is decided.",
    date: "2026-09-27",
    updated: "2026-10-01",
    readMin: 6,
    summary: "One launch, every chain: how buys add up across chains and how the winning chain is decided.",
    tags: ["multi-chain", "launch", "graduation"],
    takeaways: [
      "A multi-chain launch puts the same coin on several chains at once, so buyers on every chain can join.",
      "Buys on every chain count toward one shared graduation target, in USDC.",
      "The chain holding the most money wins and graduates into a locked pool; holders elsewhere can always sell back.",
    ],
    body: [
      { p: "Traditional launchpads make you pick one chain. Your coin can then only be bought by people who already have funds there, and everyone else has to bridge first, which most of them never do. A multi-chain launch removes that choice: the same coin goes live on several chains at once, and every buyer can use the chain they are already on." },
      { h2: "How it works on sasa" },
      { ol: [
        "You create the coin once and pick the chains, for example Robinhood Chain and Base.",
        "Your wallet confirms one launch per chain. Each chain gets the same name, ticker and picture, and its own bonding curve.",
        "Buys on every chain are added up, in dollars, toward one shared graduation target. Everyone sees a single progress bar and the live race between chains.",
        "When the total reaches the target, the chain holding the most money wins. Its curve graduates into a trading pool that is locked forever.",
        "On the other chains buying stops. Holders there can sell back to the curve at any time and take their money, or move it to the winning chain.",
      ] },
      { h2: "Why a shared target graduates faster" },
      { p: "A coin on one chain has to find all of its buyers on that chain. A coin on several chains draws from all of their communities at once, so the same target is usually reached much sooner. For creators that means less time in the fragile early phase; for buyers it means they can join from wherever their money already is." },
      { h2: "Who decides the winner?" },
      { p: "Chains cannot see each other, so a small program called a keeper adds up the curves across chains and triggers graduation. On sasa the keeper's power is deliberately narrow: it can only graduate or close a curve. It cannot move anyone's money, graduation can only send funds into the locked pool, and a chain holding almost nothing can never be made the winner. Every decision is published with a report of the numbers behind it, so anyone can check it against the chains." },
      { tip: "Nobody's money gets stuck on a losing chain. Selling back to the curve stays open forever, and the curve always holds enough to pay every holder." },
      { h2: "Things to know" },
      { ul: [
        "Each chain's curve prices the coin separately, so the price can differ slightly between chains. sasa's trade box picks the cheapest chain where your wallet has funds.",
        "Holding the coin on a chain that did not win is not a loss by itself: you can always sell back there at the curve price.",
        "Network fees apply on each chain you launch on, but on the supported chains they are usually cents.",
      ] },
    ],
    faq: [
      { q: "Is it the same coin on every chain?", a: "It has the same name, ticker and picture on every chain, and one shared graduation race. Technically each chain has its own token contract and its own curve until graduation decides where the coin lives on." },
      { q: "Which chains does sasa support?", a: "Robinhood Chain and Base today, with more chains planned." },
      { q: "What happens to my coins on the chain that lost?", a: "Buying stops there, but you can sell back to the curve at any time and receive USDC, then buy on the winning chain if you want to keep holding." },
    ],
  },
];

// Newest first on the Learn page; the first three guides come from launch week.
export const ARTICLES: Article[] = [...NEW_ARTICLES, ...MORE_ARTICLES, ...BASE_ARTICLES];

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
export const SITE_URL = "https://sasapad.fun";
