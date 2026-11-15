import type { Article } from "./articles";

/**
 * Week 3, part B (Nov 15): the words and tools people search for on their first days in meme
 * coins. Short, exact answers first (what search and AI engines quote), then the detail.
 */
export const W3_ARTICLES_B: Article[] = [
  {
    slug: "how-to-use-a-dex-screener",
    title: "How to use a DEX screener (a beginner's walkthrough)",
    description:
      "How to use a DEX screener to find and check meme coins: what each column means, how to filter new pairs, and the 6 numbers to read before you buy.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 7,
    summary:
      "A DEX screener lists coins trading on decentralized exchanges with live price, volume, liquidity and age. Six numbers on it tell you most of what you need before buying.",
    tags: ["tools", "beginner", "data", "trading"],
    takeaways: [
      "A DEX screener shows coins trading on decentralized exchanges, with live price, market cap, liquidity, volume, age and buy/sell counts.",
      "Sort by age to find new pairs, by volume or trending to find what people trade now, and always filter by chain.",
      "Before buying, read six numbers: liquidity, market cap, age, 24h volume, buys vs sells, and top-holder share.",
      "A screener listing is not a safety check; run a token check for honeypots and taxes as well.",
      "sasa's Explore and Market pages work as a screener across Solana, Base, BNB Chain, Ethereum, Robinhood Chain and Arc, with a buy button on every coin.",
    ],
    body: [
      { p: "A DEX screener is a live table of coins trading on decentralized exchanges. Each row is a trading pair, and the columns show price, change, volume, liquidity, market cap and age. Traders use screeners to find new coins and to check a coin before they buy it." },
      { h2: "What do the columns mean?" },
      { table: {
        head: ["Column", "What it tells you"],
        rows: [
          ["Price / change", "Current price and how it moved over 5m, 1h, 6h and 24h"],
          ["Liquidity", "How much money sits in the pool; what you can actually sell into"],
          ["Market cap / FDV", "Price times supply; the size people quote"],
          ["Volume", "Dollar value traded in the window"],
          ["Txns / makers", "Number of trades and of unique wallets trading"],
          ["Age", "How long ago the pool was created"],
        ],
      } },
      { p: "If market cap, FDV and liquidity blur together, read [market cap vs FDV vs liquidity](/learn/meme-coin-market-cap-vs-fdv-vs-liquidity/)." },
      { h2: "How to find new coins" },
      { ol: [
        "Pick one chain first; mixing chains makes the list noisy.",
        "Sort by age (newest first) to see pairs created minutes ago.",
        "Set a minimum liquidity, for example $10K, to hide dust pairs.",
        "Switch to a trending or volume sort to see what people are actually trading now.",
      ] },
      { p: "For more on discovery, see [how to find new Solana meme coins](/learn/how-to-find-new-solana-meme-coins/) and [how to find trending meme coins early](/learn/how-to-find-trending-meme-coins-early/)." },
      { h2: "The 6 numbers to read before you buy" },
      { ol: [
        "Liquidity: at least about 10% of the market cap makes selling easy ([can I sell this meme coin](/learn/can-i-sell-this-meme-coin/)).",
        "Market cap: where the coin sits in its life ([market cap milestones](/learn/meme-coin-market-cap-milestones/)).",
        "Age: very new pairs move hardest and fail most often.",
        "24h volume: compared with liquidity, shows whether people trade it.",
        "Buys vs sells, by unique traders: ([buys vs sells ratio](/learn/meme-coin-buys-vs-sells-what-the-ratio-tells-you/)).",
        "Top-holder share: ([how to read a holder map](/learn/how-to-read-a-holder-map/)).",
      ] },
      { tip: "A screener shows what trades, not what is safe. Run a token check for honeypots and taxes: [what is a honeypot token](/learn/what-is-a-honeypot-token/)." },
      { h2: "Using sasa as a screener" },
      { p: "sasa's [Explore](/explore/) page lists new and trending coins, and the [Market](/market/) page lists the largest coins. Every coin page shows the chart, a token check, buy/sell activity over 5M/1H/6H/24H and a \"Can you sell it?\" box, and you can buy from one USDC balance on any of its chains. If you want to compare screeners, see [DEX Screener alternatives](/learn/dexscreener-alternatives/)." },
    ],
    faq: [
      { q: "What is a DEX screener used for?", a: "To find coins trading on decentralized exchanges and check their price, liquidity, volume, age and trading activity before buying." },
      { q: "Is a coin on a DEX screener safe?", a: "Not necessarily. Any pool with trades can appear. Check liquidity, holders and run a token check for honeypots and taxes." },
      { q: "How do I find new pairs on a DEX screener?", a: "Filter by chain, sort by age with a minimum liquidity, then look at the trending or volume sort to see which new pairs people actually trade." },
    ],
  },
  {
    slug: "how-to-find-a-meme-coin-contract-address",
    title: "How to find a meme coin's contract address (and avoid fakes)",
    description:
      "How to find the real contract address (CA) of a meme coin on Solana, Base, BNB Chain or Ethereum, why tickers can't be trusted, and how to spot fake copies.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "Tickers are not unique; contract addresses are. Get the CA from the project's own posts or launch page, then check it on a screener before buying.",
    tags: ["safety", "beginner", "buying"],
    takeaways: [
      "A contract address (CA) is the unique on-chain address of a token; anyone can copy a coin's name and ticker, but not its address.",
      "Get the CA from the creator's own X post, pinned message or launch page, never from a random reply or DM.",
      "Compare the CA you paste with the one on the coin's page, character by character at the start and end.",
      "The real coin is usually the one with far more liquidity, holders and age; fakes are often minutes old.",
      "On sasa, every coin page shows its contract address with a copy button, and you can paste a CA into search.",
    ],
    body: [
      { p: "When a meme coin gets attention, copies appear within minutes: same name, same ticker, same picture, different contract. The only reliable identifier is the contract address, often shortened to CA. This guide shows where to find it and how to make sure it is the real one." },
      { h2: "What does a contract address look like?" },
      { ul: [
        "On Base, BNB Chain, Ethereum, Robinhood Chain and Arc: 0x followed by 40 letters and numbers.",
        "On Solana: 32 to 44 letters and numbers, no 0x, case-sensitive. Many pump.fun coins end in \"pump\".",
      ] },
      { h2: "Where to get the real CA" },
      { ol: [
        "The creator's own X post or pinned tweet about the launch.",
        "The launch page on the launchpad where it was created.",
        "The coin's official Telegram or website, linked from the creator's profile.",
      ] },
      { tip: "Never take a CA from a reply under a popular post or from a DM. Scammers post fake addresses under real announcements." },
      { h2: "How to check you have the right one" },
      { ol: [
        "Paste the CA into a screener or sasa's search and open the coin page.",
        "Compare the first and last six characters with the source.",
        "Look at age, liquidity and holders: the original is usually older and much deeper than copies.",
        "Run a token check before buying: [what is a honeypot token](/learn/what-is-a-honeypot-token/).",
      ] },
      { p: "If you are new to buying, read [how to buy meme coins without a wallet](/learn/how-to-buy-meme-coins-without-a-wallet/) and the [meme coin glossary](/learn/meme-coin-glossary/)." },
    ],
    faq: [
      { q: "What does CA mean in crypto?", a: "Contract address: the unique on-chain address of a token. Names and tickers can be copied; the CA cannot." },
      { q: "Can two meme coins have the same ticker?", a: "Yes. Tickers are not unique, which is why you should always buy by contract address." },
      { q: "How do I spot a fake copy of a meme coin?", a: "The copy usually has a different CA, much less liquidity, few holders and was created minutes ago. Check the CA against the creator's own post." },
    ],
  },
  {
    slug: "what-is-a-community-takeover-cto",
    title: "What is a community takeover (CTO) in meme coins?",
    description:
      "A community takeover (CTO) is when holders take over a meme coin after its creator leaves. How CTOs work, why some succeed and the risks to check.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "A CTO happens when a coin's creator abandons it and holders step in to run the socials, marketing and listings themselves.",
    tags: ["community", "glossary", "trading"],
    takeaways: [
      "A community takeover (CTO) is when holders take over running a meme coin after the creator abandons it or sells out.",
      "The new team usually opens new X and Telegram accounts, updates the coin's info on screeners and restarts marketing.",
      "The contract does not change in a CTO; only who runs the community changes.",
      "Some well-known meme coins grew after a CTO, but most CTOs fade within days.",
      "Check who leads the CTO, how much of the supply they hold and whether the original creator still holds a large bag.",
    ],
    body: [
      { p: "Many meme coins are abandoned within hours of launch: the creator sells and disappears. Sometimes the holders left behind decide the coin is worth saving. They organise, open new social accounts and keep marketing it. That is a community takeover, or CTO." },
      { h2: "How does a CTO work?" },
      { ol: [
        "The creator leaves, often after selling: see [the dev sold: what it means](/learn/what-it-means-when-the-dev-sells/).",
        "Holders gather in a new Telegram or X community and agree to take over.",
        "They make new accounts, a new website if needed, and update the coin's info on screeners.",
        "Marketing restarts: memes, raids on X, outreach to bigger accounts.",
      ] },
      { p: "The token contract stays exactly the same. A CTO changes who runs the community, not the coin's code, supply or liquidity." },
      { h2: "What to check before buying a CTO coin" },
      { ul: [
        "Who leads it, and are they known in the community?",
        "How much supply the CTO leaders hold; a few wallets holding a lot can sell on you: [how to read a holder map](/learn/how-to-read-a-holder-map/).",
        "Whether the original creator still holds a large amount.",
        "Whether liquidity is deep enough to exit: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
      ] },
      { tip: "A CTO is a fresh start for the community, not a fresh coin. Every old risk in the contract and holder list is still there." },
      { p: "If you would rather run your own coin from day one, see [how to grow a meme coin community after launch](/learn/how-to-grow-a-meme-coin-community-after-launch/)." },
    ],
    faq: [
      { q: "What does CTO mean in crypto?", a: "Community takeover: holders take over running a meme coin after its original creator abandons it." },
      { q: "Does a CTO change the token contract?", a: "No. The contract, supply and pool stay the same; only the people running the socials and marketing change." },
      { q: "Are CTO coins safer?", a: "Not by themselves. The original risks remain, and CTO leaders can hold large bags too. Check holders and liquidity." },
    ],
  },
  {
    slug: "what-does-ape-mean-in-crypto",
    title: "What does \"ape\" mean in crypto?",
    description:
      "\"Ape\" or \"aping in\" means buying a coin fast, often without research, on hype. Where the word comes from, how traders use it and how to ape without getting wrecked.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "To ape is to buy quickly and with conviction, usually because of hype rather than research. It can catch early moves and it can wipe out a wallet.",
    tags: ["glossary", "slang", "beginner"],
    takeaways: [
      "\"Ape\" or \"ape in\" means buying a coin quickly and heavily, often on hype and without much research.",
      "The term comes from internet trading culture, where \"apes\" act together and on instinct.",
      "Aping works best with a size you can afford to lose completely.",
      "A 30-second check (contract, liquidity, top holders) before aping avoids most disasters.",
    ],
    body: [
      { p: "In crypto, to ape means to buy fast and big, usually because something is moving or everyone is talking about it, and usually before doing much research. \"I aped into it\" means \"I bought it on impulse\"." },
      { h2: "Where does the word come from?" },
      { p: "It comes from online trading communities in the early 2020s, where traders jokingly called themselves apes: acting on instinct, together, without overthinking. Crypto adopted it for any fast, conviction buy." },
      { h2: "How to ape without getting wrecked" },
      { ol: [
        "Size it so losing everything doesn't hurt: [how big should your first buy be](/learn/how-big-should-your-first-buy-be/).",
        "Check the contract for honeypots and taxes: [what is a honeypot token](/learn/what-is-a-honeypot-token/).",
        "Check liquidity vs market cap: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
        "Set your exit before you buy: [take profit and stop loss for meme coins](/learn/take-profit-stop-loss-meme-coins/).",
      ] },
      { p: "More slang: [what is a jeet](/learn/what-is-a-jeet-in-crypto/), [what is a degen](/learn/what-is-a-degen-in-crypto/), [what is FUD](/learn/what-is-fud-in-crypto/) and the full [meme coin glossary](/learn/meme-coin-glossary/)." },
    ],
    faq: [
      { q: "What does aping in mean?", a: "Buying a coin quickly and heavily, usually on hype rather than research." },
      { q: "Is aping a good strategy?", a: "It can catch early moves, but most aped coins lose value. Only ape with money you can afford to lose and check the contract and liquidity first." },
    ],
  },
  {
    slug: "what-is-a-jeet-in-crypto",
    title: "What is a jeet in crypto?",
    description:
      "A jeet is a trader who sells a meme coin quickly for a small profit or at the first dip. What the slang means, why communities hate jeets and what it says about a coin.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "A jeet sells fast: at the first small gain or the first dip. Every coin has them; what matters is whether new buyers absorb their selling.",
    tags: ["glossary", "slang", "trading"],
    takeaways: [
      "In meme coin slang, a jeet is someone who sells very quickly, for a small profit or at the first sign of a dip.",
      "Communities dislike jeets because quick selling pushes the price down early.",
      "Every coin has jeets; a healthy coin is one where new buyers absorb their selling.",
      "Taking profit is not a crime: selling part of a position after a big move is normal risk management.",
    ],
    body: [
      { p: "A jeet is a trader who sells a meme coin very quickly: right after a small pump, or at the first dip. In chats you will see \"jeets sold\" after a candle drops, or \"no jeets\" as a rallying cry from holders." },
      { h2: "Why do communities hate jeets?" },
      { p: "Early in a coin's life the pool is small, so every sell moves the price. A wave of quick sells can turn a promising chart into a dump, and the holders who stayed watch their value fall. Calling sellers jeets is a way to pressure people to hold." },
      { h2: "Does jeeting tell you anything?" },
      { p: "Yes. If many small sells hit the coin and the price holds, new buyers are absorbing them: a sign of real demand. If a few sells crash it, the pool is thin or buyers are gone. Watch buys vs sells by unique traders over 5m and 1h: [buys vs sells ratio](/learn/meme-coin-buys-vs-sells-what-the-ratio-tells-you/)." },
      { tip: "Selling part of a position after a big move is just taking profit. Plan it: [take profit and stop loss for meme coins](/learn/take-profit-stop-loss-meme-coins/)." },
      { p: "More slang: [what does ape mean](/learn/what-does-ape-mean-in-crypto/), [what is a degen](/learn/what-is-a-degen-in-crypto/) and the [meme coin glossary](/learn/meme-coin-glossary/)." },
    ],
    faq: [
      { q: "What does jeet mean in meme coins?", a: "A trader who sells very quickly, for a small profit or at the first dip." },
      { q: "Is it bad to be a jeet?", a: "Communities use it as an insult, but taking profit or cutting losses is a normal part of trading. Plan your exits in advance." },
    ],
  },
  {
    slug: "what-is-a-degen-in-crypto",
    title: "What is a degen in crypto?",
    description:
      "A degen is a crypto trader who takes high-risk bets on new meme coins, leverage and early launches. What degen means, degen habits and how to degen more safely.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "\"Degen\" (from degenerate) describes traders who chase the riskiest plays: brand-new coins, leverage, early launches. Many wear it proudly.",
    tags: ["glossary", "slang", "beginner"],
    takeaways: [
      "Degen is short for degenerate and describes a trader who takes very high-risk bets: new meme coins, leverage, early launches.",
      "In crypto it is usually said with pride or humour, not as an insult.",
      "Degen plays can return many times the money and can go to zero in minutes.",
      "Degening more safely means small sizes, fast checks and exits planned in advance.",
    ],
    body: [
      { p: "A degen is a trader who goes for the riskiest bets crypto has: coins launched minutes ago, high leverage, unknown chains, early launches. The word is short for degenerate, and in crypto it is usually used with a wink." },
      { h2: "What do degens do?" },
      { ul: [
        "Buy new launches in their first minutes.",
        "Trade with leverage on futures: [how to short a crypto coin with futures](/learn/how-to-short-a-crypto-coin-with-futures/).",
        "Follow whales and copy big wallets: [copy-trading whales](/learn/copy-trading-whales/).",
        "Launch their own coins: [how to create a meme coin without coding](/learn/how-to-create-a-meme-coin-without-coding/).",
      ] },
      { h2: "How to degen a bit more safely" },
      { ol: [
        "Use a separate, small budget you treat as already spent.",
        "Run a token check and look at liquidity before every buy: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
        "Set exits first: [take profit and stop loss](/learn/take-profit-stop-loss-meme-coins/).",
        "Avoid leverage on coins with thin order books or pools.",
      ] },
      { p: "More slang: [what does ape mean](/learn/what-does-ape-mean-in-crypto/), [what is a jeet](/learn/what-is-a-jeet-in-crypto/), [what is a KOL](/learn/what-is-a-kol-in-crypto/)." },
    ],
    faq: [
      { q: "What does degen mean in crypto?", a: "A trader who takes very high-risk bets, such as brand-new meme coins and leverage. It is short for degenerate." },
      { q: "Is degen an insult?", a: "Usually not in crypto; many traders call themselves degens with pride or humour." },
    ],
  },
  {
    slug: "what-is-a-kol-in-crypto",
    title: "What is a KOL in crypto? (and how to read their calls)",
    description:
      "KOL means key opinion leader: a crypto influencer whose posts move prices. How KOL calls work, paid promotions, and how to check a call before buying.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "KOLs are crypto influencers with big followings. Their calls can move a meme coin within minutes, which is exactly why you should check what they hold before following.",
    tags: ["glossary", "slang", "trading", "x"],
    takeaways: [
      "KOL stands for key opinion leader: an influencer whose posts can move a coin's price.",
      "Some KOL posts are paid promotions; many countries require them to be disclosed, but not all are.",
      "KOLs often buy before they post, so followers can end up buying their exit.",
      "Before following a call, check when the price moved, who holds the supply and whether the pool can take your sell.",
    ],
    body: [
      { p: "In crypto, KOL means key opinion leader: someone with a large, engaged audience whose posts can move prices. When a KOL posts a coin's contract address, buyers can pile in within seconds." },
      { h2: "How KOL calls work" },
      { p: "A KOL posts a coin, often with a chart and a short reason. Followers buy, the price jumps, and later buyers pay more. Some KOLs buy before posting; some are paid by the project to post. Paid posts are supposed to be disclosed in many places, but not every post is." },
      { h2: "How to check a call before you buy" },
      { ol: [
        "Look at the chart: did the price already jump before the post?",
        "Check the holder map for large early wallets: [how to read a holder map](/learn/how-to-read-a-holder-map/).",
        "Look at the biggest recent trades: [how to read big crypto trades](/learn/how-to-read-big-crypto-trades/).",
        "Make sure the pool can take your sell: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
      ] },
      { tip: "If you are reading the call, you are probably not early. Size accordingly." },
      { p: "If you launch coins yourself, posting honestly works better long-term than paid hype: [how to grow a meme coin community after launch](/learn/how-to-grow-a-meme-coin-community-after-launch/)." },
    ],
    faq: [
      { q: "What does KOL mean in crypto?", a: "Key opinion leader: an influencer whose posts can move a coin's price." },
      { q: "Should I buy coins that KOLs post?", a: "Only after checking whether the price already moved, who holds the supply and whether you can sell. KOLs often buy before posting." },
    ],
  },
  {
    slug: "what-is-fud-in-crypto",
    title: "What is FUD in crypto? How to tell FUD from a real warning",
    description:
      "FUD means fear, uncertainty and doubt: negative claims that push prices down. How to tell baseless FUD from a real red flag about a meme coin, with a quick checklist.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "Communities call any bad news FUD. Some of it is noise; some of it is the warning that saves you. On-chain data tells them apart.",
    tags: ["glossary", "slang", "safety"],
    takeaways: [
      "FUD stands for fear, uncertainty and doubt: negative claims that make people sell.",
      "Communities often label every criticism FUD, including real warnings.",
      "Check claims on-chain: dev wallet sales, top-holder share, liquidity changes and contract powers can be verified.",
      "Baseless FUD fades when the data doesn't support it; real problems show up in the data.",
    ],
    body: [
      { p: "FUD means fear, uncertainty and doubt. In crypto it describes negative claims that spread and make people sell, whether or not they are true. \"Ignore the FUD\" is one of the most common lines in any meme coin chat." },
      { h2: "FUD or a real warning?" },
      { table: {
        head: ["Claim", "How to check it"],
        rows: [
          ["\"The dev sold\"", "Look for the DEV tag in the trade list: [the dev sold](/learn/what-it-means-when-the-dev-sells/)"],
          ["\"Bundled / insiders hold it all\"", "Check the holder map: [how to spot bundled wallets](/learn/how-to-spot-bundled-wallets/)"],
          ["\"You can't sell\"", "Run a token check: [what is a honeypot token](/learn/what-is-a-honeypot-token/)"],
          ["\"Liquidity was pulled\"", "Check the pool and lock: [how to check if liquidity is locked](/learn/how-to-check-if-liquidity-is-locked/)"],
          ["\"It's going to zero\"", "An opinion, not a fact; look at volume and unique traders"],
        ],
      } },
      { h2: "Why both sides use the word" },
      { p: "Holders call criticism FUD to protect the price; sometimes traders spread FUD to buy cheaper. Neither side is a reliable source. The data is." },
      { p: "More slang: [what is a KOL](/learn/what-is-a-kol-in-crypto/), [what is a CTO](/learn/what-is-a-community-takeover-cto/) and the [meme coin glossary](/learn/meme-coin-glossary/)." },
    ],
    faq: [
      { q: "What does FUD stand for?", a: "Fear, uncertainty and doubt." },
      { q: "How do I know if something is FUD?", a: "Check the claim on-chain: dev sales, holder share, liquidity and contract powers can all be verified. If the data doesn't back it, it's probably FUD." },
    ],
  },
];
