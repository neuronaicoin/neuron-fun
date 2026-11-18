// The X bot's feature threads: every thread shows ONE sasa feature, in 6 posts (a hook, 4 posts
// that explain it, a closing call to launch/try), each post with its own 1600x900 card
// (xthreadcards.mjs) and a heavy, varied hashtag set. Written to read like a person wrote it:
// lower case, short lines, CAPS on the one word that matters, a question to pull replies.
//
// Facts only from the site itself (no made-up numbers, no other brands named). Each feature has
// three openers; the bot picks one it hasn't used lately, so the same feature never opens the same
// way twice in a row.

const L = "sasapad.fun";

// shared tags, mixed into every post
const GENERAL = ["#crypto", "#memecoin", "#memecoins", "#altcoins", "#CryptoTwitter", "#Web3", "#degen", "#altseason", "#100x", "#DeFi", "#memecoinseason", "#bullrun"];

export const FEATURES = [
  {
    id: "race",
    link: `${L}/race`,
    tags: ["#Base", "#BNBChain", "#RobinhoodChain", "#Arc", "#DEX", "#LiquidityLocked"],
    hooks: [
      { text: "imagine launching a meme coin and instead of praying on one chain, 4 chains FIGHT over it\n\nsame coin, same CA, 5 minutes on the clock. most money wins EVERYTHING 🧵", card: { type: "big", shot: "race", big: ["ONE COIN.", "4 CHAINS.", "5 MINUTES.", "ONE WINNER."], sub: "the meme launch that turns into a race" } },
      { text: "most meme coins die on one chain with nobody watching\n\non sasa they launch on 4 chains at once and the chains RACE for 5 minutes. here's how it works 🧵", card: { type: "big", shot: "race", big: ["ROBINHOOD.", "BASE. BNB.", "ARC.", "WHO WINS?"], sub: "the 5-minute chain race, live on sasa" } },
      { text: "what if your meme coin had a 5 minute countdown and 4 chains fighting to keep it?\n\nthat's the sasa race. and the loser chains don't just lose 👀🧵", card: { type: "big", shot: "race", big: ["5:00", "ON THE CLOCK.", "WINNER", "TAKES ALL."], sub: "one coin, one CA, every chain" } },
    ],
    body: [
      { text: "no bonding curve. no waiting to \"graduate\"\n\nyour coin opens in a real DEX pool on every chain you pick from second one, same contract address everywhere", card: { type: "shot", shot: "race", title: "same CA on every chain", lines: ["live in a real DEX pool from second one", "no bonding curve", "on DexScreener in seconds"] } },
      { text: "then the clock starts\n\nbuyers pick a side with \"Buy on Base\", \"Buy on BNB\"... a live board shows who's LEADING and how long is left. the last minute gets loud", card: { type: "steps", shot: "race2", title: "how the race goes", steps: [["launch on every chain", "same coin, same address"], ["5-minute race", "buyers back a chain"], ["one winner", "most money in dollars wins"]] } },
      { text: "at 0:00 the winner eats the losers\n\nall the money from the other chains moves into the winning pool, holders' coins move with it, and that pool is locked FOREVER", card: { type: "shot", shot: "race2", title: "the winner eats the losers", lines: ["every other chain's money moves", "into the winning pool", "holders' coins move with it", "pool locked forever"] } },
      { text: "one deep pool instead of 4 dead ones\n\nthat's the whole idea. no rug-able liquidity, no 4 half-empty charts. one coin people actually fought for", card: { type: "big", shot: "race2", big: ["NOT 4 DEAD", "POOLS.", "ONE DEEP ONE."], sub: "liquidity locked forever after the race" } },
    ],
    cta: { text: "so which chain are you backing? Robinhood, Base, BNB or Arc 👇\n\nlaunch on any chain and hold $10K for 1 hour, 60% of the trade fees are yours", card: { type: "cta" } },
    single: { text: "4 chains. 5 minutes. one coin.\n\nthe chain with the most money takes the whole pool and locks it forever\n\nwhich chain wins your bet? 👇", card: { type: "big", shot: "race", big: ["4 CHAINS.", "5 MINUTES.", "ONE WINNER."], sub: "the sasa launch race" } },
  },
  {
    id: "ai",
    link: `${L}/create`,
    tags: ["#AI", "#CryptoAI", "#AIart", "#Solana", "#Base", "#memecoinlaunch"],
    hooks: [
      { text: "a meme is pumping and you're LATE again?\n\non sasa you tap the trend and AI builds your coin in seconds. name, ticker, story AND the picture 🧵", card: { type: "shot", shot: "ai", title: "tap the trend. AI makes the coin", lines: ["the board shows what's pumping right now", "pick a topic, get a coin in seconds"] } },
      { text: "you don't need a designer, a copywriter or an idea anymore\n\nyou need one tap. sasa's AI turns today's trend into a ready-to-launch coin 🧵", card: { type: "big", shot: "ai2", big: ["ONE TAP.", "ONE TREND.", "ONE COIN."], sub: "name, ticker, story and picture by AI" } },
      { text: "everyone has a meme coin idea in their notes app\n\nmost never launch because the name, logo and story take forever. we fixed that part 🧵", card: { type: "big", shot: "ai2", big: ["YOUR IDEA.", "AI DOES", "THE REST."], sub: "from a few words to a full coin in seconds" } },
    ],
    body: [
      { text: "step one: the trend board\n\n\"Trending right now\" shows the themes and coins pumping across all chains, updated through the day", card: { type: "shot", shot: "ai", title: "see the meta before CT does", lines: ["themes trending across all chains", "the coins riding them, live"] } },
      { text: "step two: tap a theme\n\nwe tapped \"gta\" just to see. got Gta Goat, ticker GTAG, a goat causing chaos in the city, picture done. didn't type a word", card: { type: "shot", shot: "ai2", title: "we tapped 'gta' and got this", lines: ["name: Gta Goat · ticker: GTAG", "story + picture written by AI", "zero typing"] } },
      { text: "don't like it? write a few words of your own idea and hit it again\n\nyou can change the name, ticker or story before you launch. the AI just kills the blank page", card: { type: "steps", shot: "ai2", title: "from idea to coin", steps: [["pick a trend or type an idea", "a few words is enough"], ["AI fills everything", "name, ticker, story, picture"], ["edit anything you want", "then launch"]] } },
      { text: "step three: pick a chain and make your first buy\n\nRobinhood, Solana, Base, BNB or Arc. that's it, you're live", card: { type: "shot", shot: "launch", title: "launch it in a minute", lines: ["name, picture, chain, first buy", "live and tradable right away"] } },
    ],
    cta: { text: "ride the hype while it's still HYPE ⏳\n\nhold $10K market cap for 1 hour and 60% of every trade fee is yours\n\nwhat trend would you turn into a coin? 👇", card: { type: "cta" } },
    single: { text: "tap a trend. AI writes the name, the ticker, the story and draws the picture\n\nyour meme coin is ready before the trend is over\n\nwhat would you launch today? 👇", card: { type: "shot", shot: "ai2", title: "AI builds your meme coin", lines: ["from today's trend", "in seconds"] } },
  },
  {
    id: "earn60",
    link: `${L}/create`,
    tags: ["#passiveincome", "#CryptoCreators", "#USDC", "#Solana", "#Base", "#BNBChain"],
    hooks: [
      { text: "imagine getting PAID every time someone trades your meme coin\n\nnot points. not a maybe-airdrop. real USDC, every day 🧵", card: { type: "big", shot: "launch", big: ["YOUR COIN.", "THEIR TRADES.", "YOUR FEES."], sub: "60% of every trade fee, paid in USDC" } },
      { text: "most creators launch, dump, and move on\n\non sasa the smart move is to HOLD the line, because the fees keep paying you. here's the deal 🧵", card: { type: "big", shot: "launch", big: ["PASS $10K.", "HOLD 1 HOUR.", "EARN 60%."], sub: "the sasa creator deal" } },
      { text: "what if your meme coin paid you rent?\n\nthat's basically what 60% of the trade fees is. 🧵", card: { type: "big", shot: "launch", big: ["60%", "OF EVERY", "TRADE FEE."], sub: "goes to the coin's creator on sasa" } },
    ],
    body: [
      { text: "the rule is simple\n\nyour coin passes $10K market cap and stays there for 1 hour. from then on 60% of the trading fees go to you, sasa keeps 40%", card: { type: "shot", shot: "launch", title: "hit $10K, keep it 1 hour", lines: ["60% of every trade's fee is yours", "sasa keeps 40%"] } },
      { text: "paid in USDC, to your account, every day\n\nas long as the coin stays above $10K, the fees keep coming", card: { type: "big", shot: "launch", big: ["PAID IN", "USDC.", "EVERY DAY."], sub: "as long as your coin stays above $10K" } },
      { text: "works on every chain sasa launches on\n\nSolana, Base, BNB, Robinhood and Arc. pick the crowd you know best", card: { type: "cta", title: "Same deal on every chain" } },
      { text: "and you don't need a design team\n\nAI can make the name, ticker, story and picture from today's trend in seconds. launching takes about a minute", card: { type: "shot", shot: "ai2", title: "launch in a minute", lines: ["AI fills the name, ticker and picture", "pick a chain, first buy, live"] } },
    ],
    cta: { text: "your community trades, you earn. that's the whole pitch\n\nwhich chain are you launching on? 👇", card: { type: "cta" } },
    single: { text: "launch a meme coin. keep it above $10K for 1 hour. get 60% of every trade fee in USDC, every day\n\nwhy would you launch anywhere else? 👇", card: { type: "big", shot: "launch", big: ["PASS $10K.", "HOLD 1 HOUR.", "EARN 60%."], sub: "paid daily in USDC" } },
  },
  {
    id: "explore",
    link: `${L}/explore`,
    tags: ["#Solana", "#Base", "#BNBChain", "#RobinhoodChain", "#Elysium", "#gems"],
    hooks: [
      { text: "finding the next meme before it runs shouldn't take 6 tabs and 3 wallets\n\nsasa Explore puts the fresh ones from every chain on ONE list 🧵", card: { type: "shot", shot: "explore", title: "every chain's memes on one list", lines: ["Elysium · Robinhood · Solana", "Base · BNB · Arc"] } },
      { text: "the memes that ran today, on one screen, ranked by REAL volume\n\nand you can buy any of them with USDC in one tap 🧵", card: { type: "big", shot: "explore", big: ["EVERY CHAIN.", "ONE LIST.", "ONE TAP."], sub: "sasa Explore" } },
      { text: "stop chain-hopping to catch a pump\n\nhere's how sasa shows you what's moving everywhere, at once 🧵", card: { type: "big", shot: "explore", big: ["STOP", "CHAIN-HOPPING."], sub: "fresh memes from every chain, one screen" } },
    ],
    body: [
      { text: "tabs that matter: Trending, New, Racing now, Winners\n\nNew only shows fresh coins, Racing now shows the live chain races", card: { type: "shot", shot: "explore", title: "trending, new, racing now", lines: ["ranked by real volume", "fresh coins only in New"] } },
      { text: "filter by chain in one tap\n\nElysium, Robinhood, Solana and more. or just leave it on all of them and watch", card: { type: "big", shot: "explore", big: ["ALL CHAINS", "OR JUST", "YOURS."], sub: "chain filters in one tap" } },
      { text: "see a coin you like? buy it with USDC in one tap\n\nno bridging, no swapping gas tokens first. your balance is your balance", card: { type: "shot", shot: "terminal", title: "buy any meme in one tap", lines: ["plain USDC", "no bridging first"] } },
      { text: "before you ape, check it\n\npaste the address into the free rug check: can it be sold, can the owner print more, who holds it", card: { type: "shot", shot: "scan", title: "check before you buy", lines: ["can it be sold?", "can the owner mint more?", "who holds it?"] } },
    ],
    cta: { text: "found one you like? or want to be the one people find?\n\nlaunch on any chain, hold $10K for 1 hour and 60% of the trade fees are yours 👇", card: { type: "cta" } },
    single: { text: "the hottest memes on Solana, Base, BNB, Robinhood and more. one list. buy any with USDC in one tap\n\nwhat are you watching today? 👇", card: { type: "shot", shot: "explore", title: "every chain's memes, one list", lines: ["ranked by real volume"] } },
  },
  {
    id: "scan",
    link: `${L}/scan`,
    tags: ["#rugpull", "#CryptoSafety", "#DYOR", "#Base", "#BNBChain", "#Ethereum"],
    hooks: [
      { text: "you've been rugged before. everyone has\n\nhere's the free check that takes 3 seconds and tells you if a coin is a TRAP 🧵", card: { type: "shot", shot: "scan", title: "is it a rug? find out in seconds", lines: ["paste any contract address", "free, no sign up"] } },
      { text: "can you actually SELL that coin you just bought?\n\nmost people find out the hard way. here's the easy way 🧵", card: { type: "big", shot: "scan", big: ["CAN YOU", "SELL IT?"], sub: "check before you ape, free" } },
      { text: "honeypots, hidden taxes, owners who can print more tokens\n\nyou can spot all of them before you buy. free 🧵", card: { type: "big", shot: "scan", big: ["HONEYPOT?", "TAXES?", "MINT?"], sub: "sasa checks it in seconds" } },
    ],
    body: [
      { text: "paste the contract address, hit Check\n\nworks on Elysium, Base, BNB Chain, Robinhood Chain and Ethereum", card: { type: "shot", shot: "scan", title: "paste. check. done.", lines: ["Elysium · Base · BNB Chain", "Robinhood · Ethereum"] } },
      { text: "what it tells you:\n\ncan it be sold, are there taxes, can the owner print more, who holds it, is the liquidity locked", card: { type: "steps", shot: "scan", title: "what the check looks at", steps: [["can it be sold", "honeypot or not"], ["taxes + mint", "can the owner print more"], ["holders + liquidity", "who holds it, is it locked"]] } },
      { text: "and sasa Bot runs checks like this on every new coin, every second\n\nit flags creators who sell, bundles and copies before they hit your feed", card: { type: "shot", shot: "bot", title: "the bot checks every new coin", lines: ["creators who sell", "bundles", "copies"] } },
      { text: "honest note: a clean check doesn't mean the price goes up\n\nit just means it's not an obvious trap. only put in what you can lose", card: { type: "big", shot: "scan", big: ["CLEAN CHECK", "IS NOT A", "MOON SIGNAL."], sub: "a check is information, not advice" } },
    ],
    cta: { text: "check first, then trade. or launch something people don't need to check twice\n\nhold $10K for 1 hour on sasa and 60% of the trade fees are yours", card: { type: "cta" } },
    single: { text: "before you buy your next meme coin, paste the address here\n\ncan it be sold? can the owner print more? who holds it? free, in seconds\n\nhow many times have you been rugged? 👇", card: { type: "shot", shot: "scan", title: "is it safe? free rug check", lines: ["paste any contract address"] } },
  },
  {
    id: "bot",
    link: `${L}/bot`,
    tags: ["#WhaleAlert", "#Whales", "#CryptoBot", "#Solana", "#smartmoney", "#onchain"],
    hooks: [
      { text: "there's a bot watching EVERY new meme coin, every second\n\nit catches traps, follows the wallets that keep getting in early and you can see all of it 🧵", card: { type: "shot", shot: "bot", title: "sasa Bot is watching", lines: ["every new coin, every second", "traps · whales · trends"] } },
      { text: "some wallets keep getting in early. again and again\n\nsasa Bot follows them so you don't have to 🧵", card: { type: "big", shot: "bot", big: ["FOLLOW THE", "WALLETS THAT", "KEEP WINNING."], sub: "sasa Bot, live" } },
      { text: "the WHALES move first. the timeline finds out later\n\nhere's how to see it while it's happening 🧵", card: { type: "big", shot: "bot", big: ["WHALES", "MOVE FIRST."], sub: "sasa Bot shows it live" } },
    ],
    body: [
      { text: "meme whales: every big buy on fresh coins shows up live, with what they paid and how it's doing since", card: { type: "shot", shot: "bot", title: "every whale buy, live", lines: ["who bought, how much", "and how it's doing since"] } },
      { text: "see a wallet tagged \"7/13 ran 3x\"? it got into 13 new coins early and 7 of them ran 3x or more\n\nand there's a Buy button right next to it", card: { type: "big", shot: "bot", big: ["7/13", "RAN 3x.", "BUY IN 1 TAP."], sub: "wallets tagged with their track record" } },
      { text: "it also catches the traps: creators who sell, bundles, copies of coins that already pumped", card: { type: "shot", shot: "bot", title: "it catches the traps", lines: ["creators who sell", "bundled launches", "copycats"] } },
      { text: "and there's a futures whales tab too\n\nthe biggest leveraged positions in the market, long or short, as they open", card: { type: "shot", shot: "pulse", title: "futures WHALES too", lines: ["the biggest positions", "long or short, as they open"] } },
    ],
    cta: { text: "watch the whales, or be the coin they buy\n\nlaunch on any chain on sasa, hold $10K for 1 hour, earn 60% of the trade fees 👇", card: { type: "cta" } },
    single: { text: "a bot that watches every new meme coin every second, catches the traps and follows the wallets that keep getting in early\n\nand it's free to look 👀", card: { type: "shot", shot: "bot", title: "sasa Bot is LIVE", lines: ["traps · whales · trends"] } },
  },
  {
    id: "pulse",
    link: `${L}/pulse`,
    tags: ["#Bitcoin", "#BTC", "#WhaleAlert", "#CryptoTrading", "#FearAndGreed", "#futures"],
    hooks: [
      { text: "the whole crypto market on ONE live screen\n\nwhale trades as they hit, futures, stocks, odds, fear & greed. we called it Pulse 🧵", card: { type: "shot", shot: "pulse", title: "the whole market, one screen", lines: ["whales · futures · stocks", "odds · fear & greed"] } },
      { text: "you have 9 tabs open to know what the market is doing\n\nyou need one 🧵", card: { type: "big", shot: "pulse", big: ["9 TABS?", "TRY ONE."], sub: "sasa Pulse, live" } },
      { text: "the WHALES don't tweet before they trade\n\nbut you can watch them the second they do 🧵", card: { type: "big", shot: "pulse", big: ["WATCH THE", "WHALES", "LIVE."], sub: "every big trade the second it lands" } },
    ],
    body: [
      { text: "the live wire on top: every whale trade the moment it lands, long or short, with the size", card: { type: "shot", shot: "pulse", title: "the live wire", lines: ["every whale trade", "the second it lands"] } },
      { text: "in the middle, the orbit: whales, futures, funding, predictions, stocks and movers, all moving in real time", card: { type: "shot", shot: "pulsehome", title: "everything moving, live", lines: ["whales · funding · movers", "predictions · stocks"] } },
      { text: "fear & greed and the whales' long/short split right there\n\nwhen the crowd is scared and whales go the other way, pay attention", card: { type: "big", shot: "pulsehome", big: ["FEAR?", "WHAT ARE THE", "WHALES DOING?"], sub: "the long/short split, live" } },
      { text: "stocks trade 24/7 on there too. and you can trade straight from the screen", card: { type: "shot", shot: "futures", title: "see it, trade it", lines: ["crypto and stocks", "straight from your balance"] } },
    ],
    cta: { text: "watching is free. what you do with it is up to you 👀\n\nand if you'd rather build: launch on any chain on sasa, hold $10K for 1 hour, earn 60% of the fees", card: { type: "cta" } },
    single: { text: "whale trades as they hit, futures, stocks 24/7, prediction odds, fear & greed\n\none live screen. what's the first thing you check every morning? 👇", card: { type: "shot", shot: "pulse", title: "sasa Pulse", lines: ["the whole market, live"] } },
  },
  {
    id: "futures",
    link: `${L}/futures`,
    tags: ["#Bitcoin", "#Ethereum", "#Solana", "#leverage", "#futures", "#CryptoTrading"],
    hooks: [
      { text: "most people think sasa is just a meme launchpad\n\nyou can go LONG or SHORT on Bitcoin, Ethereum, Solana and more with up to 20x, from the same balance 🧵", card: { type: "shot", shot: "futures", title: "long or short, up to 20x", lines: ["BTC · ETH · SOL and more", "from your sasa balance"] } },
      { text: "market dumped and your bags are red?\n\nsome people went SHORT and are smiling. here's how that works on sasa 🧵", card: { type: "big", shot: "futures", big: ["RED DAY?", "GO SHORT."], sub: "futures on sasa, up to 20x" } },
      { text: "memes in one tab, futures in another, a third app for stocks...\n\nor one balance that does all of it 🧵", card: { type: "big", shot: "futures2", big: ["ONE BALANCE.", "MEMES.", "FUTURES."], sub: "long or short from the same account" } },
    ],
    body: [
      { text: "pick a market, see the live chart, 24h volume, open interest and funding at a glance", card: { type: "shot", shot: "futures", title: "the market at a glance", lines: ["live chart", "volume · open interest · funding"] } },
      { text: "Long or Short, market or limit, type how much and pick your leverage\n\n25%, 50%, 75% or Max of your balance in one tap", card: { type: "shot", shot: "futures2", title: "Long or Short in seconds", lines: ["market or limit", "pick your leverage"] } },
      { text: "stocks and commodities trade 24/7 too\n\nnews drops on a sunday? you don't have to wait for monday", card: { type: "big", shot: "futures", big: ["STOCKS.", "COMMODITIES.", "24/7."], sub: "no waiting for the bell" } },
      { text: "honest part: leverage cuts both ways and you can lose what you put in\n\nfutures aren't available in some countries (US, UK and others)", card: { type: "big", shot: "futures2", big: ["LEVERAGE", "CUTS BOTH", "WAYS."], sub: "trade small, know your exit" } },
    ],
    cta: { text: "long, short, or launch your own coin and let others trade it\n\nhold $10K for 1 hour on sasa and 60% of the trade fees are yours 👇", card: { type: "cta" } },
    single: { text: "long or short on Bitcoin, Ethereum, Solana and more, up to 20x, from the same balance you buy memes with\n\nare you long or short tonight? 👇", card: { type: "shot", shot: "futures", title: "long or short, up to 20x", lines: ["from your sasa balance"] } },
  },
  {
    id: "predict",
    link: `${L}/predict`,
    tags: ["#Bitcoin", "#BTC", "#PredictionMarkets", "#CryptoTrading", "#UpOrDown", "#HYPE"],
    hooks: [
      { text: "will Bitcoin be UP or DOWN when this clock hits zero?\n\nthat's the whole game. and you see what you win before you tap 🧵", card: { type: "shot", shot: "predict", title: "UP or DOWN?", lines: ["live price, live target", "the clock is running"] } },
      { text: "you don't need leverage to bet on a price move\n\npick Up or Down, wait for the clock. right side pays $1 a share 🧵", card: { type: "big", shot: "predict2", big: ["UP?", "DOWN?", "PICK ONE."], sub: "sasa Predict, live rounds" } },
      { text: "the simplest trade in crypto: one question, one clock, two buttons 🧵", card: { type: "big", shot: "predict", big: ["ONE QUESTION.", "ONE CLOCK.", "TWO BUTTONS."], sub: "sasa Predict" } },
    ],
    body: [
      { text: "every round has a live chart, a dashed TARGET line and a countdown\n\nyou watch the price fight the line in real time", card: { type: "shot", shot: "predict", title: "price vs the target, live", lines: ["dashed target line", "countdown bar"] } },
      { text: "pick $15, $25, $50 or $100, then Up or Down\n\nit shows exactly what Up pays, what Down pays and what you lose if you're wrong. before you tap", card: { type: "steps", shot: "predict2", title: "how a round works", steps: [["pick a size", "$15, $25, $50 or $100"], ["Up or Down", "see what you win first"], ["wait for the clock", "right side pays $1 a share"]] } },
      { text: "your entry shows up as a dot on the chart\n\nso you can watch exactly where you got in vs where it's going", card: { type: "shot", shot: "predict2", title: "your entry, on the chart", lines: ["a dot where you got in", "the clock does the rest"] } },
      { text: "not just Bitcoin: other coins, sports matches and rate decisions too\n\nyes or no, the right answer pays $1 a share", card: { type: "big", shot: "predict", big: ["PRICES.", "MATCHES.", "RATES."], sub: "yes or no, $1 a share" } },
    ],
    cta: { text: "so, Bitcoin in the next round: UP or DOWN? 👇\n\nand if you'd rather build: launch on any chain on sasa, hold $10K for 1 hour, earn 60% of the fees", card: { type: "cta" } },
    single: { text: "Bitcoin. one clock. Up or Down\n\nyou see what you win before you tap, the right side pays $1 a share\n\nwhat's your call for the next hour? 👇", card: { type: "shot", shot: "predict2", title: "UP or DOWN?", lines: ["see what you win first"] } },
  },
  {
    id: "terminal",
    link: `${L}/terminal`,
    tags: ["#RobinhoodChain", "#Base", "#BNBChain", "#DEX", "#CryptoTrading", "#TakeProfit"],
    hooks: [
      { text: "trading memes from a block explorer and 4 wallet popups is a choice\n\nhere's the other choice 🧵", card: { type: "shot", shot: "terminal", title: "the meme coin terminal", lines: ["live charts · trades · holders", "one tap, plain USDC"] } },
      { text: "the meme pumped while you were approving 3 transactions\n\nnever again 🧵", card: { type: "big", shot: "terminal", big: ["ONE TAP.", "PLAIN USDC.", "DONE."], sub: "the sasa terminal" } },
      { text: "set a take profit, set a stop loss, go to sleep\n\nfor meme coins. yes really 🧵", card: { type: "big", shot: "terminal", big: ["TAKE PROFIT.", "STOP LOSS.", "SLEEP."], sub: "on meme coins, on sasa" } },
    ],
    body: [
      { text: "Trending, Gainers, Losers, Almost graduating\n\nevery meme with its chain, market cap and 24h move, live", card: { type: "shot", shot: "terminal", title: "every meme, live", lines: ["trending · gainers · losers", "almost graduating"] } },
      { text: "open one and you get the live chart, every trade and the holders list\n\nwhere the money is going, not where it was", card: { type: "big", shot: "terminal", big: ["CHART.", "TRADES.", "HOLDERS."], sub: "all live, one screen" } },
      { text: "buy and sell with USDC in one tap\n\nno swapping gas tokens around first", card: { type: "shot", shot: "terminal", title: "buy in one tap", lines: ["plain USDC", "no gas token juggling"] } },
      { text: "then set take profit and stop loss so the exit happens even if you're not looking", card: { type: "steps", shot: "terminal", title: "plan the exit first", steps: [["buy", "one tap, USDC"], ["take profit", "lock the win"], ["stop loss", "cap the damage"]] } },
    ],
    cta: { text: "trade the memes, or make the next one\n\nlaunch on any chain on sasa, hold $10K for 1 hour, 60% of the trade fees are yours 👇", card: { type: "cta" } },
    single: { text: "live charts, every trade, holders. buy with USDC in one tap. take profit and stop loss on meme coins\n\nwhat's your exit rule? 👇", card: { type: "shot", shot: "terminal", title: "the meme terminal", lines: ["one tap · TP · SL"] } },
  },
  {
    id: "spot",
    link: `${L}/market`,
    tags: ["#Bitcoin", "#Ethereum", "#BNB", "#HYPE", "#BTC", "#ETH"],
    hooks: [
      { text: "you came for the memes. you can stay for Bitcoin\n\nthe biggest coins in crypto, buy and sell with USDC in one tap 🧵", card: { type: "shot", shot: "spot", title: "the big coins too", lines: ["Bitcoin · Ethereum · BNB", "one tap, plain USDC"] } },
      { text: "memes AND majors from one balance\n\nno second app, no second account 🧵", card: { type: "big", shot: "spot", big: ["MEMES.", "MAJORS.", "ONE BALANCE."], sub: "sasa Market" } },
      { text: "taking profit on a meme? you don't have to leave to buy BTC with it 🧵", card: { type: "big", shot: "spot", big: ["MEME PROFIT", "INTO BTC.", "ONE TAP."], sub: "without leaving sasa" } },
    ],
    body: [
      { text: "Top, Gainers, Losers, Volume\n\nthe biggest coins with live prices and 24h moves", card: { type: "shot", shot: "spot", title: "the market, live", lines: ["top · gainers · losers · volume"] } },
      { text: "tap a coin, type an amount, done\n\nbuy and sell in plain USDC", card: { type: "big", shot: "spot", big: ["TAP.", "AMOUNT.", "DONE."], sub: "buy and sell in USDC" } },
      { text: "same balance works for futures and predictions too\n\nlong, short, up or down, without moving money around", card: { type: "shot", shot: "futures", title: "same balance, more ways", lines: ["futures · predictions", "no moving money around"] } },
      { text: "and Pulse shows what the WHALES are doing on the big coins while you decide", card: { type: "shot", shot: "pulsehome", title: "check the whales first", lines: ["long/short split, live"] } },
    ],
    cta: { text: "BTC for the long run, memes for the fun\n\nor launch your own: hold $10K for 1 hour on sasa, earn 60% of the trade fees 👇", card: { type: "cta" } },
    single: { text: "Bitcoin, Ethereum, BNB and the rest of the big ones. buy and sell with USDC in one tap, same balance as your memes\n\nwhat are you stacking? 👇", card: { type: "shot", shot: "spot", title: "the big coins, one tap", lines: ["plain USDC"] } },
  },
  {
    id: "invite",
    link: `${L}/points`,
    tags: ["#USDC", "#passiveincome", "#referral", "#CryptoCreators", "#earncrypto", "#Solana"],
    hooks: [
      { text: "no token. no airdrop. no points to wait for\n\nsasa pays in real USDC, from real trading fees. here's every way to earn 🧵", card: { type: "shot", shot: "earn", title: "earn real USDC", lines: ["no token, no airdrop", "real trading fees"] } },
      { text: "tired of farming points that turn into nothing?\n\nhere's a platform that just pays you USDC 🧵", card: { type: "big", shot: "earn", big: ["NO POINTS.", "NO AIRDROP.", "JUST USDC."], sub: "earn on sasa" } },
      { text: "two ways to get paid on sasa without being a trading genius 🧵", card: { type: "big", shot: "earn", big: ["CREATE.", "INVITE.", "GET PAID."], sub: "real USDC from real fees" } },
    ],
    body: [
      { text: "way 1: create a coin\n\nonce it holds $10K market cap for an hour, 60% of its trading fees go to you", card: { type: "shot", shot: "launch", title: "60% to the creator", lines: ["hold $10K for 1 hour", "paid daily in USDC"] } },
      { text: "way 2: invite friends\n\nyou get 25% of sasa's fees on your friends' trades", card: { type: "big", shot: "earn", big: ["25%", "OF THE FEES", "ON FRIENDS."], sub: "every trade they make" } },
      { text: "all paid in USDC\n\nnot a token you have to dump, not points that \"might\" convert someday", card: { type: "big", shot: "earn", big: ["REAL", "USDC."], sub: "from real trading fees" } },
      { text: "and launching a coin takes about a minute\n\nAI can even write the name, ticker and picture from today's trend", card: { type: "shot", shot: "ai2", title: "launching is the easy part", lines: ["AI fills it in", "pick a chain, go"] } },
    ],
    cta: { text: "who are you inviting first? 👇\n\nlaunch on any chain on sasa, hold $10K for 1 hour, 60% of the trade fees are yours", card: { type: "cta" } },
    single: { text: "no token, no airdrop, no points\n\n60% of your coin's trade fees + 25% of sasa's fees on friends you invite, paid in real USDC\n\nwho's in? 👇", card: { type: "big", shot: "earn", big: ["NO POINTS.", "JUST USDC."], sub: "earn on sasa" } },
  },
  {
    id: "anychain",
    link: `${L}/create`,
    tags: ["#Solana", "#Base", "#BNBChain", "#RobinhoodChain", "#Arc", "#multichain"],
    hooks: [
      { text: "Solana? Base? BNB? Robinhood Chain? Arc?\n\non sasa you don't have to pick a side forever. launch where your people are 🧵", card: { type: "cta", title: "Pick your chain. Any chain." } },
      { text: "every chain has its own meme crowd\n\nsasa lets you launch into any of them from one place 🧵", card: { type: "big", shot: "launch", big: ["ANY CHAIN.", "ONE", "LAUNCHPAD."], sub: "Solana · Base · BNB · Robinhood · Arc" } },
      { text: "is Solana still the home of memes? is Robinhood Chain next?\n\nwhy guess. launch on whichever you want 🧵", card: { type: "big", shot: "launch", big: ["WHICH CHAIN", "RUNS THE", "NEXT META?"], sub: "launch on any of them" } },
    ],
    body: [
      { text: "pick the chain on the launch page: Robinhood, Solana, Base, BNB or Arc\n\nor race it on 4 chains at once", card: { type: "shot", shot: "ai2", title: "your chain, your call", lines: ["Robinhood · Solana · Base", "BNB · Arc"] } },
      { text: "deposit from any chain, trade everything in plain USDC\n\nno network settings, no gas token hunting", card: { type: "big", shot: "spot", big: ["ONE BALANCE.", "EVERY", "CHAIN."], sub: "plain USDC" } },
      { text: "Explore shows the fresh memes from every chain on one list, so your coin sits next to the ones already running", card: { type: "shot", shot: "explore", title: "every chain, one list", lines: ["your coin, right there"] } },
      { text: "same creator deal on every chain\n\nhold $10K market cap for 1 hour and 60% of the trade fees are yours", card: { type: "cta" } },
    ],
    cta: { text: "so where are you launching? Solana, Base, BNB, Robinhood or Arc? 👇", card: { type: "cta" } },
    single: { text: "Solana, Base, BNB, Robinhood or Arc. launch your meme on any of them from one place, earn 60% of the fees once it holds $10K\n\nwhich chain runs the next meta? 👇", card: { type: "cta" } },
  },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

/** X's count: URLs are 23, emoji and other wide characters 2. */
export function xLen(t) {
  let s = String(t).replace(/(https?:\/\/)?[a-z0-9-]+\.(fun|com|io|xyz)(\/[^\s]*)?/gi, "x".repeat(23));
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) > 0x10ff ? 2 : 1;
  return n;
}

/** The post's text with as many tags as fit (3 to 6): the feature's first, then general ones. */
function withTags(text, f, extra = "") {
  const body = extra ? `${text}\n${extra}` : text;
  const tags = [...new Set([...shuffle(f.tags).slice(0, 3), ...shuffle(GENERAL)])];
  let out = body;
  let line = "";
  for (const t of tags) {
    const next = line ? `${line} ${t}` : t;
    if (xLen(`${body}\n${next}`) > 278 || next.split(" ").length > 6) break;
    line = next;
  }
  return line ? `${out}\n${line}` : out;
}

/**
 * The posts of one thread about `featureId` (hook variant `hookIdx`): [{ text, card }], 6 posts.
 * The link goes on the first and the last post.
 */
export function buildThread(featureId, hookIdx = 0) {
  const f = FEATURES.find((x) => x.id === featureId) || FEATURES[0];
  const hook = f.hooks[hookIdx % f.hooks.length];
  const posts = [{ text: withTags(hook.text, f, f.link), card: { ...hook.card, link: f.link } }];
  for (const b of f.body) posts.push({ text: withTags(b.text, f), card: { ...b.card, link: f.link } });
  posts.push({ text: withTags(f.cta.text, f, `${L}`), card: { ...f.cta.card, link: L } });
  return posts;
}

/** One stand-alone post about a feature (the 11:00 and 13:00 slots). */
export function buildSingle(featureId) {
  const f = FEATURES.find((x) => x.id === featureId) || FEATURES[0];
  return { text: withTags(f.single.text, f, f.link), card: { ...f.single.card, link: f.link } };
}

export const FEATURE_IDS = FEATURES.map((f) => f.id);
export { pick };
