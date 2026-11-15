import type { Article } from "./articles";

/**
 * Week 3, part C (Nov 15): money questions and trader slang people search for. Each answers one
 * question in the first lines, then links into the guides around it. Keep every claim true today.
 */
export const W3_ARTICLES_C: Article[] = [
  {
    slug: "how-to-make-money-with-meme-coins",
    title: "How to make money with meme coins (honestly)",
    description:
      "The real ways people make money with meme coins: trading early, taking profit, creating a coin and earning its fees, referrals. What works, what it costs and the risks.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 7,
    summary:
      "There are four ways people make money with meme coins: buying early and selling well, launching a coin and earning its trading fees, sharing in fees through referrals, and building tools. Most traders lose money; the plan matters more than the pick.",
    tags: ["earning", "trading", "beginner", "strategy"],
    takeaways: [
      "Most people who trade meme coins lose money; the ones who don't usually trade small, exit in parts and skip coins they can't sell.",
      "Trading: buy early, take profit in steps, and never size a position you can't afford to lose completely.",
      "Creating: a coin's creator earns a share of every trade's fee; on sasa that is 30%, or 60% once the coin holds a $10K market cap for an hour.",
      "Referrals: on sasa you earn 25% of sasa's fees on the trades of people you invite, for a year.",
      "Avoid anything that promises returns, asks you to connect to a \"claim\" link, or needs you to recruit buyers.",
    ],
    body: [
      { p: "Meme coins can make money, and they lose much more of it. Before the methods, the honest part: most meme coins go to zero, and most people who trade them end up behind. The people who do well tend to treat it as a game with rules, not a lottery ticket." },
      { h2: "1. Trading: buy early, sell well" },
      { p: "This is what most people mean. You buy a coin before others notice it and sell after they do. The hard part is not the buying; it is selling. Three habits matter most:" },
      { ul: [
        "Check before you buy: contract, liquidity and holders. [Can I sell this meme coin](/learn/can-i-sell-this-meme-coin/) and [what is a honeypot token](/learn/what-is-a-honeypot-token/) cover the 30-second checks.",
        "Size small: [how big should your first buy be](/learn/how-big-should-your-first-buy-be/).",
        "Take profit in steps and keep a small rest: [take profit and stop loss](/learn/take-profit-stop-loss-meme-coins/) and [what is a moonbag](/learn/what-is-a-moonbag/).",
      ] },
      { h2: "2. Creating a coin and earning its fees" },
      { p: "Every trade of a coin pays a fee, and many launchpads give part of it to the coin's creator. A coin that keeps trading keeps paying. On sasa, the creator gets 30% of each trade's fee, and 60% once the coin holds a $10K market cap for one hour, paid daily in USDC: [earn 60% of your meme coin's trading fees](/learn/earn-60-percent-of-your-meme-coin-trading-fees/). The catch is that a coin nobody trades earns nothing, so the work is in the community: [how to grow a meme coin community after launch](/learn/how-to-grow-a-meme-coin-community-after-launch/)." },
      { h2: "3. Referrals" },
      { p: "Some apps share their fees with people who bring in traders. On sasa, you get 25% of sasa's fees on the trades of people you invite, for a year, paid into your cash. It pays only if the people you invite actually trade." },
      { h2: "4. Building tools" },
      { p: "Bots, dashboards, alert channels and research newsletters make money from traders whatever the market does. It takes skill and time, but it is the most durable of the four." },
      { h2: "What to avoid" },
      { ul: [
        "Anything that promises a return or a multiplier.",
        "\"Holder rewards\" or \"claim\" links from accounts that aren't the project: classic wallet drainers.",
        "Presales and schemes that need you to recruit buyers: [what is a meme coin presale](/learn/what-is-a-meme-coin-presale/) and [what is a pump and dump](/learn/what-is-a-pump-and-dump/).",
      ] },
      { tip: "Only use money you can afford to lose completely. That rule alone keeps most people in the game long enough to learn it." },
    ],
    faq: [
      { q: "Can you really make money with meme coins?", a: "Some people do, through careful trading, launching coins that earn trading fees, or referrals. Most traders lose money, so small sizes and planned exits matter." },
      { q: "What is the safest way to earn from meme coins?", a: "Earning fees (as a coin creator or through referrals) does not require you to predict prices, but it only pays if people trade. No method is risk-free." },
    ],
  },
  {
    slug: "what-is-a-pump-and-dump",
    title: "What is a pump and dump in crypto? How to spot one",
    description:
      "A pump and dump inflates a coin's price with hype so insiders can sell to latecomers. How crypto pump and dumps work, the warning signs, and how to avoid being the exit.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "In a pump and dump, insiders buy cheap, hype the coin until others buy, then sell into that demand. The price collapses and latecomers hold the loss.",
    tags: ["safety", "scams", "glossary"],
    takeaways: [
      "A pump and dump is a scheme where insiders buy a coin cheap, hype it to attract buyers, then sell everything into that demand.",
      "Signs: a sudden coordinated wave of posts, promises of a multiplier, a few wallets holding most of the supply, and a pool too thin for the market cap.",
      "Paid or coordinated shilling groups often run them; the people posting usually bought first.",
      "Check the holder map and the dev wallet's trades before buying a coin everyone suddenly talks about.",
    ],
    body: [
      { p: "A pump and dump works in three steps: insiders accumulate a coin while it is cheap; they create hype through posts, groups and paid promoters until new buyers rush in; then they sell into that rush. Once their selling ends, there are no buyers left and the price collapses." },
      { h2: "Warning signs" },
      { ul: [
        "Many accounts post the same coin at the same time, often with the same wording.",
        "Promises of a multiplier (\"easy 100x\"), a countdown or a \"last chance\".",
        "A few wallets hold most of the supply: [how to read a holder map](/learn/how-to-read-a-holder-map/).",
        "Linked wallets that bought in the first seconds: [how to spot bundled wallets](/learn/how-to-spot-bundled-wallets/).",
        "Liquidity far too small for the market cap: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
      ] },
      { h2: "How to avoid being the exit" },
      { p: "Look at when the price moved compared with when the posts started. If the chart already ran before the hype reached you, you are likely late. Check who holds the supply, watch the dev wallet ([the dev sold: what it means](/learn/what-it-means-when-the-dev-sells/)) and decide your exit before buying." },
      { tip: "Organising a pump and dump is illegal in many countries. Joining \"pump groups\" also usually means you are the liquidity for the organisers." },
    ],
    faq: [
      { q: "Are all meme coin pumps pump and dumps?", a: "No. Coins also rise from real attention. The difference is whether a small group bought first and planned to sell into the hype." },
      { q: "How do I know if a coin is being dumped?", a: "Watch for large sells from early wallets or the dev wallet, falling unique buyers, and the price failing to recover after each spike." },
    ],
  },
  {
    slug: "what-is-a-meme-coin-presale",
    title: "What is a meme coin presale (and why most are risky)",
    description:
      "A meme coin presale asks you to send money before the coin trades. How presales work, why so many are scams, and the questions to ask before you send anything.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "In a presale you pay before the coin exists on the market and trust the team to deliver tokens later. That trust is exactly what scammers exploit.",
    tags: ["safety", "scams", "buying"],
    takeaways: [
      "A presale is a sale of a coin's tokens before it starts trading; buyers send money first and receive tokens later.",
      "Because you can't sell until launch, you depend entirely on the team keeping its word.",
      "Many meme coin presales never launch, launch with the team dumping, or lock buyers' tokens for months.",
      "Fair launches, where everyone buys from the same open curve at the same time, remove the pay-first-trust-later step.",
    ],
    body: [
      { p: "A presale lets people buy a coin's tokens before the coin trades anywhere. You send SOL, ETH or stablecoins to a wallet or contract and are promised tokens at launch. Until then you can't sell, and you can't easily check what you will actually get." },
      { h2: "Why presales go wrong" },
      { ul: [
        "The team keeps the money and never launches.",
        "The coin launches, but the team and early wallets sell immediately.",
        "Your tokens are locked or \"vested\" for months while the price falls.",
        "The presale site itself is fake, a copy of a real project.",
      ] },
      { h2: "Questions to ask before sending anything" },
      { ol: [
        "Who is the team, and have they launched before?",
        "Where exactly does the money go, and can you check the contract?",
        "When and how do you get tokens, and are they locked?",
        "How much of the supply do the team and presale buyers hold? See [how to read a holder map](/learn/how-to-read-a-holder-map/).",
      ] },
      { h2: "The alternative: fair launches" },
      { p: "On a fair launch, a coin goes live on a public curve or pool and everyone buys at the same time, on chain, with no pay-first step. [How meme coin launchpads work](/learn/how-meme-coin-launchpads-work/) and [what is a bonding curve](/learn/what-is-a-bonding-curve/) explain how." },
    ],
    faq: [
      { q: "Are meme coin presales legal?", a: "It depends on the country and how the sale is run. Many presales fall under securities or consumer rules, and many are simply scams." },
      { q: "Is a presale cheaper than buying at launch?", a: "It is often priced lower, but you take the risk that the coin never launches or that early holders dump on day one." },
    ],
  },
  {
    slug: "what-is-wash-trading-in-crypto",
    title: "What is wash trading in crypto? How fake volume works",
    description:
      "Wash trading is buying and selling to yourself to fake volume. How it inflates meme coin charts and trending lists, and how to tell real activity from fake.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "Wash trading creates volume with no real change of hands. It pushes coins up trending lists and makes thin coins look busy.",
    tags: ["safety", "data", "trading"],
    takeaways: [
      "Wash trading means the same person or group buys and sells to themselves to create fake volume.",
      "It is used to climb trending lists and make a coin look active.",
      "Signs: high volume with very few unique traders, trades of near-identical size at regular intervals, and price barely moving despite huge volume.",
      "Compare volume with the number of unique traders and with pool liquidity.",
    ],
    body: [
      { p: "Volume is one of the first numbers traders look at, so it is one of the first that gets faked. In wash trading, a wallet (or a set of wallets controlled by the same person) buys and sells the same coin back and forth. Nothing really changes hands, but the volume counter goes up." },
      { h2: "Why do people wash trade?" },
      { ul: [
        "To climb trending lists, which bring real buyers.",
        "To make a coin look alive so new buyers trust it.",
        "To farm volume-based rewards on some platforms.",
      ] },
      { h2: "How to spot fake volume" },
      { table: {
        head: ["Signal", "What it suggests"],
        rows: [
          ["Huge volume, few unique traders", "The same wallets trading back and forth"],
          ["Trades of the same size every few seconds", "A bot looping"],
          ["Volume many times the pool, price flat", "Volume not driven by real demand"],
          ["Many new wallets funded from one source", "One operator behind many accounts"],
        ],
      } },
      { p: "On sasa coin pages, the activity box shows transactions, volume and unique traders for 5M/1H/6H/24H side by side, so a gap between them stands out: [meme coin buys vs sells](/learn/meme-coin-buys-vs-sells-what-the-ratio-tells-you/)." },
    ],
    faq: [
      { q: "Is wash trading illegal?", a: "In regulated markets it is generally illegal market manipulation. In crypto, rules vary by country, but it is widely considered manipulative." },
      { q: "Can trending lists be faked?", a: "Lists based mostly on volume can be gamed by wash trading. Look at unique traders and liquidity, not volume alone." },
    ],
  },
  {
    slug: "is-it-too-late-to-buy-a-meme-coin",
    title: "Is it too late to buy this meme coin? 5 questions to ask",
    description:
      "How to tell if it's too late to buy a meme coin that already pumped: five questions on timing, holders, liquidity, attention and your exit, with examples.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 5,
    summary:
      "Nobody knows the top, but five questions tell you whether you would be early, on time, or someone's exit.",
    tags: ["trading", "strategy", "beginner"],
    takeaways: [
      "Ask when you heard about it: if it reached you through big accounts, many bought before you.",
      "Check whether early wallets and the dev still hold or are selling into new buyers.",
      "Look at whether new unique traders are still arriving or the same wallets are churning.",
      "Make sure the pool can take your exit before you buy.",
      "If you buy late, buy smaller and plan the exit first.",
    ],
    body: [
      { p: "The coin is up 10x and everyone is posting it. Is it too late? Nobody can call the top, but you can tell where you are in the move." },
      { h2: "1. How did you hear about it?" },
      { p: "If it reached you through large accounts or news, it has already passed through several waves of buyers. Being late is not automatically wrong, but it changes how much you should risk." },
      { h2: "2. Are early holders selling?" },
      { p: "Check the holder map and the dev wallet. Early wallets selling into each green candle is a sign you would be buying their exit: [how to read a holder map](/learn/how-to-read-a-holder-map/), [the dev sold](/learn/what-it-means-when-the-dev-sells/)." },
      { h2: "3. Are new people still arriving?" },
      { p: "Look at unique traders over the last hour, not just volume. Rising unique buyers means fresh attention; flat traders with high volume means churn: [buys vs sells](/learn/meme-coin-buys-vs-sells-what-the-ratio-tells-you/)." },
      { h2: "4. Can you get out?" },
      { p: "Check liquidity against market cap and the drop for your sell size: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/)." },
      { h2: "5. What is your plan if it halves?" },
      { p: "Decide before you buy. If you have no answer, the position is too big: [take profit and stop loss](/learn/take-profit-stop-loss-meme-coins/)." },
    ],
    faq: [
      { q: "Should I buy a meme coin after it pumped?", a: "Only with a size you can afford to lose and an exit plan. Check whether early holders are selling and whether new buyers are still arriving." },
      { q: "How do I know a meme coin has peaked?", a: "You can't know for sure. Falling unique buyers, early wallets selling and lower highs are common signs that momentum is fading." },
    ],
  },
  {
    slug: "diamond-hands-vs-paper-hands",
    title: "Diamond hands vs paper hands: what they mean in crypto",
    description:
      "Diamond hands means holding through big swings; paper hands means selling early or on fear. What the slang means and when each is actually the smart move.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "Diamond hands hold no matter what; paper hands sell at the first scare. Communities praise one and mock the other, but good trading uses both.",
    tags: ["glossary", "slang", "trading"],
    takeaways: [
      "Diamond hands (💎🙌) means holding a coin through big drops instead of selling.",
      "Paper hands (🧻🙌) means selling early, often on fear or a small dip.",
      "Communities praise diamond hands because holding supports the price.",
      "Holding a coin whose holders, dev and liquidity are falling apart isn't conviction; it's ignoring information.",
    ],
    body: [
      { p: "\"Diamond hands\" describes holders who don't sell however much the price swings. \"Paper hands\" describes people who sell quickly, usually at the first dip. Both come from trading forums and are now everywhere in meme coin chats." },
      { h2: "When diamond hands make sense" },
      { p: "When you bought with a size you can afford to lose, the community is growing, early wallets aren't dumping and the pool is healthy. Then a dip is noise." },
      { h2: "When \"paper hands\" is just good risk management" },
      { p: "When the dev sold, a few wallets hold most of the supply, liquidity is draining, or the coin was a hype play that has peaked. Selling then isn't weakness. See [the dev sold](/learn/what-it-means-when-the-dev-sells/) and [is it too late to buy](/learn/is-it-too-late-to-buy-a-meme-coin/)." },
      { tip: "A common middle path: sell your starting amount after a big run and hold the rest as a [moonbag](/learn/what-is-a-moonbag/)." },
      { p: "More slang: [what is a jeet](/learn/what-is-a-jeet-in-crypto/), [what is a bag holder](/learn/what-is-a-bag-holder/), [what does WAGMI mean](/learn/what-does-wagmi-mean/)." },
    ],
    faq: [
      { q: "What does diamond hands mean?", a: "Holding a coin through big price drops instead of selling." },
      { q: "What does paper hands mean?", a: "Selling quickly, usually at the first small dip or out of fear." },
    ],
  },
  {
    slug: "what-is-a-bag-holder",
    title: "What is a bag holder in crypto?",
    description:
      "A bag holder is someone left holding a coin that has crashed and that nobody wants to buy. How people end up holding the bag, and how to avoid it.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "A bag holder keeps a coin after its price collapses, usually because they bought late and waited for a recovery that didn't come.",
    tags: ["glossary", "slang", "trading"],
    takeaways: [
      "A bag holder is someone stuck holding a coin that has lost most of its value.",
      "It usually happens after buying late in a hype wave and refusing to sell at a loss.",
      "In thin pools, bag holders often can't sell even if they want to without crashing the price further.",
      "Planning your exit and checking liquidity before buying are the best protection.",
    ],
    body: [
      { p: "\"Holding the bag\" means you are the one left with a coin after everyone else sold. The price has fallen, buyers have gone, and selling now locks in a big loss, so many people hold and hope." },
      { h2: "How people become bag holders" },
      { ul: [
        "Buying late, after others already took profit: [is it too late to buy](/learn/is-it-too-late-to-buy-a-meme-coin/).",
        "Buying into a [pump and dump](/learn/what-is-a-pump-and-dump/).",
        "No exit plan, so every drop becomes \"I'll wait for it to come back\".",
        "Buying a coin with a thin pool and finding they can't sell without crashing it: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
      ] },
      { h2: "How to avoid it" },
      { p: "Decide your exit before you buy, sell in parts on the way up, and keep positions small enough that a full loss doesn't hurt: [take profit and stop loss](/learn/take-profit-stop-loss-meme-coins/)." },
    ],
    faq: [
      { q: "What does holding the bag mean?", a: "Being left with a coin that has crashed after others sold, usually at a large loss." },
      { q: "Should I sell or hold a coin that crashed?", a: "Ask whether you'd buy it today at this price. If not, holding is just hoping. Check holders, liquidity and whether the community is still active." },
    ],
  },
  {
    slug: "what-does-wagmi-mean",
    title: "What does WAGMI mean? (and NGMI, GM, LFG)",
    description:
      "WAGMI means \"we're all gonna make it\". The meaning of WAGMI, NGMI, GM, GN and LFG in crypto, where they come from and how people use them.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 3,
    summary:
      "WAGMI, NGMI, GM and LFG are the greetings and cheers of crypto Twitter. Here is what each means and how it's used.",
    tags: ["glossary", "slang", "beginner"],
    takeaways: [
      "WAGMI = \"we're all gonna make it\": optimism and community spirit.",
      "NGMI = \"not gonna make it\": said about a bad decision or idea.",
      "GM / GN = good morning / good night: the daily hello of crypto Twitter.",
      "LFG = \"let's f***ing go\": excitement about a launch or a pump.",
    ],
    body: [
      { p: "Crypto Twitter has its own greetings. They look like noise at first, but they signal belonging, and you will see them under almost every post." },
      { table: {
        head: ["Term", "Meaning", "Typical use"],
        rows: [
          ["WAGMI", "We're all gonna make it", "Cheering a community or a rough market"],
          ["NGMI", "Not gonna make it", "Teasing a bad trade or take"],
          ["GM / GN", "Good morning / good night", "Daily hello, often to start conversations"],
          ["LFG", "Let's f***ing go", "Excitement about a launch or move"],
          ["WEN", "When", "Impatience: \"wen launch\", \"wen moon\""],
        ],
      } },
      { p: "More: [what does ape mean](/learn/what-does-ape-mean-in-crypto/), [what does DYOR mean](/learn/what-does-dyor-mean/), [diamond hands vs paper hands](/learn/diamond-hands-vs-paper-hands/) and the full [meme coin glossary](/learn/meme-coin-glossary/)." },
    ],
    faq: [
      { q: "What does WAGMI stand for?", a: "We're all gonna make it." },
      { q: "What does NGMI mean?", a: "Not gonna make it, usually said jokingly about a bad decision." },
    ],
  },
  {
    slug: "what-does-dyor-mean",
    title: "What does DYOR mean in crypto? A practical checklist",
    description:
      "DYOR means \"do your own research\". What it means in crypto, why everyone says it, and a practical 5-minute research checklist for any meme coin.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "DYOR is said after almost every shill. Here is what research actually means for a meme coin, in five minutes.",
    tags: ["glossary", "slang", "safety"],
    takeaways: [
      "DYOR stands for \"do your own research\".",
      "People add it to posts so they aren't blamed if a coin fails; it doesn't mean they did any research themselves.",
      "For a meme coin, five minutes of research covers the contract, liquidity, holders, dev wallet and real activity.",
    ],
    body: [
      { p: "DYOR means \"do your own research\". In practice, it is often a disclaimer on a shill: the person posting is telling you not to blame them. Real research for a meme coin doesn't take hours; it takes five minutes and a checklist." },
      { h2: "The 5-minute DYOR checklist" },
      { ol: [
        "Contract: no honeypot, low or no tax, no surprise minting: [what is a honeypot token](/learn/what-is-a-honeypot-token/).",
        "Liquidity vs market cap: can you sell? [Can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
        "Holders: who owns the supply? [How to read a holder map](/learn/how-to-read-a-holder-map/).",
        "Dev wallet: has the creator sold? [The dev sold](/learn/what-it-means-when-the-dev-sells/).",
        "Activity: unique buyers, not just volume: [what is wash trading](/learn/what-is-wash-trading-in-crypto/).",
      ] },
      { tip: "Get the contract address from the project's own post before you check anything: [how to find a meme coin's contract address](/learn/how-to-find-a-meme-coin-contract-address/)." },
    ],
    faq: [
      { q: "What does DYOR stand for?", a: "Do your own research." },
      { q: "How do I research a meme coin quickly?", a: "Check the contract, liquidity versus market cap, the holder map, the dev wallet and the number of unique traders." },
    ],
  },
  {
    slug: "what-is-a-moonbag",
    title: "What is a moonbag in crypto? How to keep one",
    description:
      "A moonbag is the small part of a position you keep after taking profit, in case the coin keeps running. How moonbags work and how to size one.",
    date: "2026-11-15",
    updated: "2026-11-15",
    readMin: 4,
    summary:
      "Sell enough to be safe, keep a little for the upside. That leftover is your moonbag.",
    tags: ["glossary", "slang", "trading", "strategy"],
    takeaways: [
      "A moonbag is the small amount of a coin you keep after selling most of it.",
      "A common approach: sell your starting amount after a big run, then hold the rest as \"house money\".",
      "It lets you lock in a profit and still benefit if the coin keeps going up.",
      "Size it so you'd be fine if it went to zero.",
    ],
    body: [
      { p: "Selling everything after a run often means watching it double again without you. Holding everything often means watching profits disappear. A moonbag splits the difference: take your profit, keep a small piece." },
      { h2: "How to set one up" },
      { ol: [
        "After a big move (say 2–3x), sell enough to recover what you put in.",
        "Optionally sell a little more to lock in some profit.",
        "Keep the rest. It is now \"free\": if it goes to zero, you lost nothing you started with.",
      ] },
      { h2: "Mistakes to avoid" },
      { ul: [
        "Calling your whole position a moonbag to avoid selling.",
        "Keeping a moonbag in a coin with a thin pool you can't exit later: [can I sell this meme coin](/learn/can-i-sell-this-meme-coin/).",
        "Forgetting moonbags across dozens of dead coins; review them now and then.",
      ] },
      { p: "Related: [take profit and stop loss](/learn/take-profit-stop-loss-meme-coins/), [diamond hands vs paper hands](/learn/diamond-hands-vs-paper-hands/)." },
    ],
    faq: [
      { q: "What is a moonbag?", a: "The small part of a crypto position you keep after selling most of it, in case the price keeps rising." },
      { q: "How big should a moonbag be?", a: "Small enough that losing it entirely wouldn't bother you. Many traders keep 10–25% after recovering their starting amount." },
    ],
  },
];
