// The X bot's words (xbot.mjs). Each kind of post has many ways of saying it; the bot picks one
// it hasn't used for that kind in the last 7 days, so the account never reads like a template.
// Style: lowercase and loose like a person typing, attention words in CAPS, the coin as a
// $CASHTAG (X turns it into a price chip), a question or a hook, then 4 hashtags.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export function money(v) {
  const a = Math.abs(num(v));
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3)}K`;
  return `$${Math.round(a)}`;
}
const px = (p) => (p >= 1000 ? `$${Math.round(p).toLocaleString("en-US")}` : p >= 1 ? `$${p.toFixed(2)}` : `$${Number(Number(p).toPrecision(4))}`);
const pct = (v) => `${v >= 0 ? "+" : "-"}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}%`;
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((x) => x[1]);

const NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", DOGE: "Dogecoin", HYPE: "Hyperliquid", BNB: "BNB",
  TSLA: "Tesla", NVDA: "Nvidia", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Google", META: "Meta", NFLX: "Netflix",
  AMD: "AMD", HOOD: "Robinhood", COIN: "Coinbase", MSTR: "MicroStrategy", PLTR: "Palantir", GOLD: "Gold", SILVER: "Silver",
  CL: "Oil", OIL: "Oil", BRENTOIL: "Oil", NATGAS: "NaturalGas", XYZ100: "Nasdaq", SPX: "SP500",
};
const STOCKS = new Set(["TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NFLX", "AMD", "INTC", "HOOD", "COIN", "MSTR", "PLTR", "ORCL", "TSM"]);
export const ticker = (coin) => String(coin).slice(String(coin).indexOf(":") + 1).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "COIN";
const cash = (t) => (/^[A-Z][A-Z0-9]{0,9}$/.test(t) ? `$${t}` : t); // X cashtags: letters first, short

/** 4 hashtags: the name, then a rotating set that fits the topic. */
function tags(t, pool) {
  const name = NAMES[t] && NAMES[t].toUpperCase() !== t ? `#${NAMES[t].replace(/[^A-Za-z0-9]/g, "")}` : null;
  return [...new Set([name, ...shuffle(pool)].filter(Boolean))].slice(0, 4).join(" ");
}
const CRYPTO = ["#Crypto", "#CryptoNews", "#Altcoins", "#CryptoTrading", "#Bitcoin"];
const WHALE = ["#WhaleAlert", "#Whales", "#SmartMoney", "#Crypto", "#CryptoTrading"];

// every builder returns a list of [id, text]; ids are what "not used lately" remembers
export function whale(m, w) {
  const t = ticker(m.coin);
  const C = cash(t);
  const size = money(m.usd);
  const S = m.side === "long" ? "LONG" : "SHORT";
  const dir = m.side === "long" ? "UP" : "DOWN";
  const lev = m.lev ? `${Math.round(m.lev)}x` : null;
  const month = w.pnl_month > 0 ? money(w.pnl_month) : null;
  const rank = w.rank ? `#${w.rank}` : null;
  let v;
  if (m.kind === "open" || m.kind === "add") {
    v = [
      ["o1", `a WHALE just put ${size} on ${C} going ${dir}${lev ? ` at ${lev}` : ""} 👀${month ? `\n\nsame wallet is +${month} this month` : ""}`],
      ["o2", `${size} ${S} on ${C}. just now.${month ? `\n\nthis guy made ${month} in 30 days. you fading him?` : "\n\nyou fading this?"}`],
      ["o3", `${rank ? `the ${rank} trader on the board` : "one of the top WHALES"} just went ${S} ${C}${lev ? ` with ${lev}` : ""}\n\nhe knows something we don't?`],
      ["o4", `someone just bet ${size} that ${C} goes ${dir} from ${px(m.px)} 😳\n\nfollow or fade?`],
      ["o5", `WHALE ALERT 🐋\n\n${size} ${S} ${C}${lev ? ` · ${lev}` : ""} · entry ${px(m.px)}${month ? `\n\n+${month} this month. not a random wallet` : ""}`],
      ["o6", `${C} ${S}. ${size}. from a wallet that ${month ? `printed ${month} this month` : "rarely misses"}\n\nbookmark this one, we'll see who was right 👀`],
      ["o7", `while you were scrolling, a WHALE opened ${size} ${S} on ${C} 👀\n\nwhat's he seeing?`],
    ];
    if (m.kind === "add") v = v.map(([id, x]) => [id.replace("o", "a"), x.replace(/just (put|went|opened|bet)/, "just ADDED")]);
  } else if (m.kind === "flip") {
    v = [
      ["f1", `a WHALE just FLIPPED ${C} to ${S}. ${size} on it now 👀\n\nsomething changed his mind`],
      ["f2", `was long, now ${S}. ${size} on ${C}. ${rank ? `the ${rank} trader` : "this whale"} just switched sides 😳`],
      ["f3", `${C} FLIP 🔄 ${size} ${S}${lev ? ` at ${lev}` : ""}\n\nwhen the smart money turns around, you look`],
      ["f4", `plot twist. top WHALE just FLIPPED his ${C} position to ${S}. ${size}\n\nwhat did he see?`],
    ];
  } else {
    v = [
      ["c1", `WHALE just closed his ${size} ${C} ${S} at ${px(m.px)} 👀\n\nhe knows something?`],
      ["c2", `${rank ? `the ${rank} trader` : "a top WHALE"} just took ${size} of ${C} off the table. out.\n\ntop signal or just profit?`],
      ["c3", `${size} ${C} ${S}, gone. closed at ${px(m.px)}\n\nwhen this wallet leaves, people usually wish they'd followed`],
      ["c4", `a WHALE just walked away from ${C}. ${size} ${S} closed 👀`],
    ];
  }
  return v.map(([id, x]) => [id, `${x}\n\n${tags(t, WHALE)}`]);
}

export function fear(score, prev) {
  const lab = score <= 24 ? "EXTREME FEAR" : score <= 44 ? "FEAR" : score <= 55 ? "NEUTRAL" : score <= 74 ? "GREED" : "EXTREME GREED";
  const move = prev !== null && prev !== undefined && prev !== score ? `${prev > score ? "down" : "up"} from ${prev} yesterday` : null;
  const tg = tags("BTC", ["#FearAndGreed", "#Crypto", "#Bitcoin", "#BTC", "#CryptoMarket"]);
  const v =
    score <= 44
      ? [
          ["d1", `crypto fear & greed: ${score}. ${lab} 😬${move ? `\n\n${move}` : ""}\n\nbe greedy when others are fearful… right?`],
          ["d2", `${score}/100. ${lab}.\n\nthis is usually where WHALES start buying quietly 👀`],
          ["d3", `everyone's scared again. index at ${score}${move ? `, ${move}` : ""}\n\nare you buying this or running?`],
          ["d4", `${lab} at ${score}. last time it was this low people said "never again"… then regretted not buying`],
        ]
      : score >= 56
        ? [
            ["g1", `fear & greed just hit ${score}. ${lab} 🤑${move ? `\n\n${move}` : ""}\n\nlast time it was this high people got liquidated`],
            ["g2", `${score}/100. everyone's feeling smart again 👀\n\nwho's taking profit?`],
            ["g3", `${lab} at ${score}. this is where the WHALES start selling to you`],
          ]
        : [
            ["n1", `fear & greed sitting at ${score}${move ? ` (${move})` : ""}. nobody knows what's next, and that's exactly when the big moves come 👀`],
            ["n2", `${score}/100. dead neutral. the calm before something?`],
          ];
  return v.map(([id, x]) => [id, `${x}\n\n${tg}`]);
}

export function biggest(p) {
  const t = ticker(p.coin);
  const C = cash(t);
  const S = p.side === "long" ? "LONG" : "SHORT";
  const v = [
    ["b1", `the biggest bet a top WHALE has on right now: ${money(p.v)} ${S} on ${C} 👀\n\nif this goes wrong…`],
    ["b2", `${money(p.v)}. one position. ${C} ${S}${p.l ? ` at ${Math.round(p.l)}x` : ""}\n\nthis is what conviction looks like`],
    ["b3", `someone is sitting on a ${money(p.v)} ${C} ${S} right now and not blinking 😳`],
    ["b4", `largest open position on the board: ${C} ${S}, ${money(p.v)}\n\nwould you take the other side?`],
    ["b5", `${money(p.v)} on ${C} going ${p.side === "long" ? "UP" : "DOWN"}. one wallet. still open.\n\nwho blinks first, him or the market?`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${tags(t, WHALE)}`]);
}

export function predict(title, yes, underlying) {
  const t = ticker(underlying || "BTC");
  const C = cash(t);
  const q = title.replace(new RegExp(`^${t}\\b`), C);
  const p = Math.round(yes * 100);
  const v = [
    ["p1", `${q} market says ${p}% YES.\n\nyou think they're wrong? 👀`],
    ["p2", `${q}\n\nYES or NO. no in between`],
    ["p3", `${p}% of people think YES. ${q}\n\nright call pays $1 a share`],
    ["p4", `quick one 👇 ${q}\n\ncrowd's at ${p}/${100 - p}. which side are you?`],
    ["p5", `${q} i'd fade the crowd on this one. you?`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${tags(t, ["#Predictions", "#PredictionMarket", "#Crypto", "#Trading"])}`]);
}

export function stock(m, closed) {
  const t = ticker(m.label);
  const C = cash(t);
  const ch = pct(m.change);
  const name = NAMES[t] || m.name || t;
  const up = m.change >= 0;
  const v = closed
    ? [
        ["s1", `markets are closed. ${C} isn't 👀 ${ch}\n\nmonday open is gonna be interesting`],
        ["s2", `wall street is asleep and ${name} is ${ch} 👀\n\nyou can still go LONG or SHORT ${C} right now`],
        ["s3", `${C} ${ch} while the stock market's closed. this is the move nobody's watching`],
        ["s4", `weekend ${C} trading is wild. ${ch} already 😳`],
      ]
    : [
        ["s5", `${name} ${ch} today and it's not stopping when the bell rings 👀\n\n${C} trades 24/7`],
        ["s6", `${C} ${ch}. biggest mover of the day\n\n${up ? "chasing or waiting for a dip?" : "buying this dip or no?"}`],
        ["s7", `${C} is ${up ? "RIPPING" : "DUMPING"} ${ch} 📈\n\nlong or short it 24/7, even after hours`],
        ["s8", `${ch} on ${C} today. ${up ? "who's still holding?" : "who's buying?"} 👇`],
      ];
  const pool = STOCKS.has(t) ? ["#Stocks", "#StockMarket", "#Trading", "#WallStreet"] : ["#Commodities", "#Trading", "#Markets", "#Futures"];
  return v.map(([id, x]) => [id, `${x}\n\n${tags(t, pool)}`]);
}

export function spot(c) {
  const t = ticker(c.symbol);
  const C = cash(t);
  const ch = pct(c.change_24h);
  const v = [
    ["g1", `${C} ${ch} today. biggest gainer in the top 500 right now 👀\n\nstill early or already late?`],
    ["g2", `nothing in the top 500 is pumping like ${C} today. ${ch} 🚀\n\nyou holding any?`],
    ["g3", `${c.name} just did ${ch} in a day. #${c.rank} by market cap and moving like a meme 👀`],
    ["g4", `${C} ${ch} 📈 while most of the market is flat\n\nwhat's the catalyst?`],
    ["g5", `top gainer today: ${C} ${ch}\n\nbuy the breakout or wait for the dip? 👇`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${tags(t, ["#Altcoins", "#Crypto", "#TopGainers", "#CryptoNews", "#Altseason"])}`]);
}

export function meme(c, net) {
  const t = ticker(c.symbol);
  const C = cash(t);
  const ch = pct(c.change_24h);
  const chain = net === "BNB" ? "#BNBChain" : net === "BASE" ? "#Base" : `#${net.charAt(0)}${net.slice(1).toLowerCase()}`;
  const v = [
    ["m1", `this meme is ${ch} today on ${net} 👀\n\n${C}. ${money(c.vol)} volume in 24h. people are paying attention`],
    ["m2", `${C} ${ch} in 24 hours. ${money(c.mcap)} market cap now\n\nwho caught this one early? 🙋`],
    ["m3", `${ch} today. ${C} on ${net} is the hottest meme out there right now 🔥`],
    ["m4", `${C} went ${ch} while you were asleep 😭\n\nstill early at ${money(c.mcap)}?`],
    ["m5", `memes are back?? ${C} ${ch} today on ${net} 👀`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${[...new Set([`#${t}`, "#MemeCoin", chain, "#Memecoins", "#Crypto"])].slice(0, 4).join(" ")}`]);
}

export function poll() {
  const v = [
    ["q1", `$BTC by tonight. UP or DOWN? 👇\n\nno "crab" option, pick a side`],
    ["q2", `where's $BTC by the end of the day? vote and come back to flex 👇`],
    ["q3", `quick one. $BTC tonight 👇`],
    ["q4", `be honest. $BTC tonight? 👇`],
    ["q5", `WHALES are positioned. are you? $BTC by tonight 👇`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${tags("BTC", ["#Bitcoin", "#Crypto", "#Poll", "#BTC"])}`]);
}

export function recap(top) {
  const a = top[0];
  const sum = top.reduce((x, w) => x + w.pnl_day, 0);
  const v = [
    ["r1", `today's best WHALE is up ${money(a.pnl_day)} 👀\n\n#2 and #3 aren't far behind. guess what they're holding`],
    ["r2", `${money(a.pnl_day)} made today by one wallet. TODAY.\n\nhere's who's printing right now`],
    ["r3", `the top 3 WHALES made ${money(sum)} between them today. you're watching the wrong charts`],
    ["r4", `while CT argued about the top, these 3 wallets made ${money(sum)} today 😭`],
    ["r5", `daily WHALE leaderboard 🏆\n\n#1 +${money(a.pnl_day)}\n\nwant to see what they're holding?`],
  ];
  return v.map(([id, x]) => [id, `${x}\n\n${tags("", WHALE.concat(["#Leaderboard"]))}`]);
}

export function followup(f) {
  const t = f.hours < 1 ? `${Math.max(1, Math.round(f.hours * 60))} minutes` : `${Math.round(f.hours)}h`;
  if (f.pnl >= 0)
    return [
      ["u1", `remember this one? he just closed it. +${money(f.pnl)} in ${t} 👀\n\nfollow so you catch the next one`],
      ["u2", `and it's done. +${money(f.pnl)} in ${t}. told you this wallet doesn't miss much 🐋`],
      ["u3", `called it 👆 WHALE closed for +${money(f.pnl)} in ${t}`],
      ["u4", `update: he's out. +${money(f.pnl)}. ${t}. that's the trade`],
    ];
  return [
    ["l1", `closed. -${money(-f.pnl)} this time. even WHALES get it wrong sometimes`],
    ["l2", `he's out. took a -${money(-f.pnl)} hit on this one. next move is the one to watch 👀`],
    ["l3", `update: this one didn't work. -${money(-f.pnl)}. the market humbles everyone`],
  ];
}

export function result(r, underlying) {
  const right = Math.round((r.yesWon ? r.yes : 1 - r.yes) * 100);
  const W = r.yesWon ? "YES" : "NO";
  const C = cash(ticker(underlying));
  return [
    ["x1", `${W} won. ${C} was at ${px(r.closePx)} 👀\n\n${right}% called it. next one's already live`],
    ["x2", `and the answer is… ${W}. ${C} ${px(r.closePx)}\n\n${right < 50 ? "only " : ""}${right}% got it right. you in for the next one?`],
    ["x3", `${W} 🎯 ${C} closed at ${px(r.closePx)}. how did you call it?`],
  ];
}
