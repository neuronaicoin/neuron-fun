import { ARTICLES, SITE_URL } from "@/lib/articles";
import { IS_TESTNET } from "@/lib/config";

export const dynamic = "force-static";

/**
 * /llms.txt: what sasa is, for AI answer engines. Testnet keeps its own text; on mainnet it
 * describes the five-minute race (the only kind of coin sasa launches there).
 */
const TESTNET_HEAD = `# sasa

> sasa (https://sasapad.fun) is a multi-chain meme coin launchpad and trading app. A coin launched on sasa goes live on several chains at the same time (today Robinhood Chain and Base). Buys on every chain count toward one shared graduation target; when it is reached, the chain holding the most money wins, all the money becomes a Uniswap pool on that chain with liquidity locked forever, and holders' coins move there automatically. sasa also lists the busiest meme coins from other DEXs on Robinhood Chain, Base and more, and lets anyone trade any of them with USDC in one tap.

Status: live on testnet (free test USDC, no real value); mainnet coming soon. X: https://x.com/sasapadfun

## Key facts
- Sign in with email or Google (a wallet is created automatically) or with your own wallet.
- Everything is priced in USDC: one cash balance, deposits and withdrawals in USDC, no gas token needed and no bridging; the chain is picked automatically for each trade.
- Launching is free: a name, a ticker and a picture, or an AI designer that turns one sentence into a name, ticker, story and logo. Optional creator lock (1 or 24 hours) and optional first buy.
- Each coin has a fixed supply, no owner and no minting. Before graduation anyone can sell back to the curve; after graduation the pool's liquidity is locked forever.
- Coin pages show a live chart, trades, a holder map with linked wallets, the first 30 buyers (Who bought) with what they still hold, a safety check, comments from holders and a forum board.
- Trading tools: take profit, stop loss and buy-the-dip orders that fill automatically, price alerts with phone notifications, following traders and one-tap copy of their buys.
- Fees are listed on the Help page: https://sasapad.fun/help/
- Security review summary: https://sasapad.fun/security/

## Main pages
- [Explore](https://sasapad.fun/explore/): trending, new, almost graduating and graduated coins, ranked by real volume across every chain.
- [Terminal](https://sasapad.fun/terminal/): live trading view with charts, trades and holders.
- [Create a coin](https://sasapad.fun/create/): launch on one or several chains at once.
- [Top traders](https://sasapad.fun/traders/) · [Stats](https://sasapad.fun/stats/) · [Help](https://sasapad.fun/help/)
- [Top meme coins today](https://sasapad.fun/top/): daily lists rebuilt every 30 minutes: [trending](https://sasapad.fun/top/trending-meme-coins/), [Robinhood Chain](https://sasapad.fun/top/robinhood-chain-meme-coins/), [Base](https://sasapad.fun/top/base-meme-coins/), [BNB Chain](https://sasapad.fun/top/bnb-chain-meme-coins/), [Ethereum](https://sasapad.fun/top/ethereum-meme-coins/), [Arc](https://sasapad.fun/top/arc-meme-coins/), [biggest gainers](https://sasapad.fun/top/meme-coin-gainers/) and [new today](https://sasapad.fun/top/new-meme-coins/), plus gainers and new coins for each chain (for example [Robinhood Chain gainers](https://sasapad.fun/top/robinhood-chain-meme-coin-gainers/) and [new Base meme coins](https://sasapad.fun/top/new-base-meme-coins/)).
- [All guides in full](https://sasapad.fun/llms-full.txt): the complete text of every sasa guide in one Markdown file.
- [Coins on sasa right now](https://sasapad.fun/llms-coins.txt): plain-text list of the most traded coins with market cap, volume and links, refreshed every 30 minutes.

`;

const MAINNET_HEAD = `# sasa

> sasa (https://sasapad.fun) is a multi-chain meme coin launchpad and trading app. A coin launched on sasa goes live at the same moment on Base, BNB Chain, Robinhood Chain and Arc (or the chains its creator picks), with the same contract address and the same starting price, each in a real DEX pool (Uniswap v4; PancakeSwap Infinity on BNB Chain). Then the chains race for five minutes: every buy adds money to that chain's pool. When the five minutes are up, the chain with the most money wins: the losing chains' pools close, and their money and holders move to the winning chain, where the coin keeps trading. sasa also lists the busiest meme coins from other DEXs on Base, BNB Chain, Robinhood Chain, Arc and Ethereum, and lets anyone trade any of them with USDC.

X: https://x.com/sasapadfun

## Key facts
- Sign in with email or Google (a wallet is created automatically) or with your own wallet.
- Everything is priced in USDC. Email accounts keep one USDC balance on Base and can trade on every race chain from it; the network fees are paid from the user's own balance.
- Creating a coin: a name, a ticker and a picture, or an AI designer that turns one sentence into a name, ticker, story and picture. The creator makes the first buy on each chain (at least $1 per chain) and pays a race fee of $0.50 per chain, which covers the network fees of running the race.
- Each coin has a fixed supply of 1 billion, split evenly over its chains, no owner and no minting. Every coin trades in a DEX pool from its first second, so it shows up on DEX screeners right away.
- Race pages show every chain's money side by side, the clock, the chart, trades and holders; finished races show the winner.
- Fees are listed on the Help page: https://sasapad.fun/help/
- Security review summary: https://sasapad.fun/security/

## Main pages
- [Explore](https://sasapad.fun/explore/): live races, races that just finished, and trending, new and winning coins.
- [Create a coin](https://sasapad.fun/race/launch/): launch on one or several chains at once.
- [Races](https://sasapad.fun/races/): every race by chain and by day, with the winners.
- [Terminal](https://sasapad.fun/terminal/): live trading view for the busiest coins.
- [Stats](https://sasapad.fun/stats/) · [Help](https://sasapad.fun/help/)
- [Top meme coins today](https://sasapad.fun/top/): daily lists rebuilt every 30 minutes for every chain, the biggest gainers and the newest coins.
- [All guides in full](https://sasapad.fun/llms-full.txt): the complete text of every sasa guide in one Markdown file.
- [Coins on sasa right now](https://sasapad.fun/llms-coins.txt): plain-text list of race coins and the most traded coins with links, refreshed every 30 minutes.

`;

const FORUM = `## Forum
- [sasa forum](https://sasapad.fun/forum/): one discussion board per coin launched on sasa. Only holders can post; anyone can read.
- New threads: https://sasapad.fun/forum/feed.xml · all forum pages: https://sasapad.fun/forum/sitemap.xml

## Sitemaps
- https://sasapad.fun/sitemap.xml · https://sasapad.fun/sitemap-coins.xml · https://sasapad.fun/forum/sitemap.xml
`;

export function GET() {
  const guides = ["## Guides", ...ARTICLES.map((a) => `- [${a.title}](${SITE_URL}/learn/${a.slug}/): ${a.description}`), ""];
  const body = (IS_TESTNET ? TESTNET_HEAD : MAINNET_HEAD) + guides.join("\n") + "\n" + FORUM;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
