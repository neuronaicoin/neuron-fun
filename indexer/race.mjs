// sasa v7 (five-minute race) indexer. Follows the race contracts on every chain and keeps the
// race_* tables (race.sql) in step, plus transfers/balances for the coins' holders.
//
// Runs inside indexer.mjs (raceLoop) when race-chains.json has chains with an RPC set, or on
// its own:  node race.mjs            (loop forever)
//           RACE_ONCE=true node race.mjs   (catch every chain up to its tip, then exit; used by the check)
//
// Like the main indexer, every batch of blocks is written in one transaction together with its
// checkpoint (race_state), so a crash or restart never loses or doubles anything.
//
// Env:
//   DATABASE_URL        Postgres
//   RPC_<chainId>       RPC URL per race chain (same names as the keeper), e.g. RPC_84532
//   RACE_CHAINS_FILE    default ./race-chains.json (made from contracts-v7/deployments/race)
//   CONFIRMATIONS       blocks to stay behind the tip (default 3)
//   RACE_MAX_RANGE      blocks per batch (default 2000)
//   RACE_LIVE_MS        how often live race money is read during a race (default 3000)
//   RACE_RPC_GAP_MS     least time between two calls to one chain's RPC (default 150);
//                       RACE_RPC_GAP_MS_<chainId> for one chain (public Arc RPC: 400)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
} from "viem";

const env = (n, d) => {
  const v = process.env[n];
  return v === undefined || v === "" ? d : v;
};
const lc = (a) => a.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIRMATIONS = BigInt(env("CONFIRMATIONS", "3"));
const MAX_RANGE = BigInt(env("RACE_MAX_RANGE", "2000"));
const POLL_MS = Number(env("POLL_MS", "2500"));
const LIVE_MS = Number(env("RACE_LIVE_MS", "3000"));
const RACE_SECONDS = 300;
const ZERO = "0x0000000000000000000000000000000000000000";
const RACING = 1, WON = 2, LOST = 3;

// ------------------------------------------------------------------ events and calls

const launchedEvt = parseAbiItem(
  "event Launched(bytes32 indexed coinId, address indexed coin, address indexed seat, address creator, uint32[] eids, string name, string symbol, string logo, string description, uint8 feeMode)"
);
const hubEvts = parseAbi([
  "event ReportIn(bytes32 indexed coin, uint64 round, uint32 eid, uint256 money, uint256 sold)",
  "event Decided(bytes32 indexed coin, uint64 round, bool graduate, uint32 winner, uint256 total, uint256 poolTokens)",
  "event Settled(bytes32 indexed coin, uint32 winner, bool isWinner)",
]);
// The three builders share event names; only the payloads differ (handled by kind below).
const builderEvts = {
  eth: parseAbi([
    "event RaceReported(address indexed coin, uint256 poolEth, uint256 dollars)",
    "event RaceWon(address indexed coin, uint32 winnerEid)",
    "event RaceLost(address indexed coin, uint32 winnerEid, uint256 ethOut, uint256 coinsBurned)",
    "event HandedOver(address indexed coin, uint256 ethIn, uint256 usdcOut, uint256 gradFee)",
    "event FeesCollected(address indexed coin, uint256 ethFees, uint256 coinFees)",
  ]),
  pcs: parseAbi([
    "event RaceReported(address indexed coin, uint256 poolBnb, uint256 dollars)",
    "event RaceWon(address indexed coin, uint32 winnerEid)",
    "event RaceLost(address indexed coin, uint32 winnerEid, uint256 bnbOut, uint256 coinsBurned)",
    "event HandedOver(address indexed coin, uint256 bnbIn, uint256 usdcOut, uint256 gradFee)",
    "event FeesCollected(address indexed coin, uint256 bnbFees, uint256 coinFees)",
  ]),
  usdc: parseAbi([
    "event RaceReported(address indexed coin, uint256 poolUsdc)",
    "event RaceWon(address indexed coin, uint32 winnerEid)",
    "event RaceLost(address indexed coin, uint32 winnerEid, uint256 usdcOut, uint256 coinsBurned, uint256 gradFee)",
    "event FeesCollected(address indexed coin, uint256 usdcFees, uint256 coinFees)",
  ]),
};
// Who traded: our routers say it in their own event (needed for smart wallets, where the
// transaction's sender is a bundler). Other swaps fall back to the transaction's sender.
const routerEvts = parseAbi([
  "event Bought(address indexed coin, address indexed buyer, uint256 usdcIn, uint256 coinsOut)",
  "event Sold(address indexed coin, address indexed seller, uint256 coinsIn, uint256 usdcOut)",
  "event PoolTrade(address indexed token, address indexed trader, bool indexed isBuy, uint256 nativeAmount, uint256 tokenAmount, uint160 sqrtPriceX96After)",
]);
const swapEvt = {
  v4: parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"),
  pcs: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)"
  ),
};
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const v4KeyAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function poolKeyFor(address coin) view returns (PoolKey)",
]);
const builderRead = parseAbi([
  "function poolIdFor(address coin) view returns (bytes32)",
  "function poolAmounts(address coin) view returns (uint256 nativeAmount, uint256 coinAmount)",
]);
const racesEth = parseAbi([
  "function races(address coin) view returns (uint256 positionId, address seat, address creator, uint8 feeMode, uint64 launchedAt, uint8 state, uint32 winnerEid)",
]);
const racesPcs = parseAbi([
  "function races(address coin) view returns (address seat, address creator, uint8 feeMode, uint64 launchedAt, uint8 state, uint32 winnerEid, int24 launchLower, int24 launchUpper)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

// ------------------------------------------------------------------ chains

/**
 * Public RPCs limit requests per second (Arc answers "Request exceeds defined limit" even for a
 * few blocks when called too fast). Every call to one chain waits its turn, at least `gapMs` apart.
 */
function throttled(pub, gapMs) {
  let queue = Promise.resolve();
  let last = 0;
  const wrap = (name) => (...args) => {
    const turn = queue.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    queue = turn.catch(() => {});
    return turn.then(() => pub[name](...args));
  };
  return Object.fromEntries(["getLogs", "readContract", "getBlock", "getTransaction", "getBlockNumber"].map((n) => [n, wrap(n)]));
}

export function loadRaceChains(log = console.log) {
  const file = env("RACE_CHAINS_FILE", join(HERE, "race-chains.json"));
  let all;
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { chains: [], byEid: new Map() };
  }
  const byEid = new Map(all.map((d) => [Number(d.eid), Number(d.chainId)]));
  const chains = [];
  for (const d of all) {
    const rpcs = (process.env[`RPC_${d.chainId}`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (rpcs.length === 0) continue;
    const chain = defineChain({
      id: Number(d.chainId),
      name: `c${d.chainId}`,
      nativeCurrency: { name: "native", symbol: "N", decimals: 18 },
      rpcUrls: { default: { http: rpcs } },
    });
    chains.push({
      ...d,
      chainId: Number(d.chainId),
      eid: Number(d.eid),
      kind: d.builderKind, // eth | pcs | usdc
      native: d.builderKind === "eth" ? "ETH" : d.builderKind === "pcs" ? "BNB" : "USDC",
      factory: getAddress(d.factory),
      hub: getAddress(d.hub),
      builder: getAddress(d.builder),
      router: getAddress(d.router),
      poolManager: getAddress(d.poolManager),
      feed: d.feed && d.feed !== ZERO ? getAddress(d.feed) : null,
      usd: getAddress(d.usd),
      startBlock: BigInt(d.startBlock),
      pub: throttled(
        createPublicClient({ chain, transport: http(rpcs[0], { retryCount: 3, timeout: 20_000 }) }),
        Number(env(`RACE_RPC_GAP_MS_${d.chainId}`, env("RACE_RPC_GAP_MS", "150")))
      ),
      usdDecimals: null,
      feedDecimals: null,
      priceCache: { at: 0, usd: 0 },
    });
  }
  if (chains.length) log(`race indexer: ${chains.map((c) => c.chainId).join(", ")}`);
  return { chains, byEid };
}

const nativeDecimals = (c) => (c.kind === "usdc" ? c.usdDecimals : 18);

/** Dollars per 1 native coin (ETH/BNB from the chain's Chainlink feed; USDC = 1). Cached 30 s. */
async function usdPerNative(c) {
  if (c.kind === "usdc" || !c.feed) return 1;
  const now = Date.now();
  if (now - c.priceCache.at < 30_000 && c.priceCache.usd > 0) return c.priceCache.usd;
  if (c.feedDecimals === null) c.feedDecimals = Number(await c.pub.readContract({ address: c.feed, abi: feedAbi, functionName: "decimals" }));
  const [, answer] = await c.pub.readContract({ address: c.feed, abi: feedAbi, functionName: "latestRoundData" });
  const usd = Number(answer) / 10 ** c.feedDecimals;
  c.priceCache = { at: now, usd };
  return usd;
}

async function prepare(c) {
  if (c.usdDecimals === null) c.usdDecimals = Number(await c.pub.readContract({ address: c.usd, abi: erc20Abi, functionName: "decimals" }));
}

/** The coin's launch pool id: Uniswap v4 = keccak(abi.encode(PoolKey)); PancakeSwap Infinity asks the builder. */
async function poolIdOf(c, coin) {
  if (c.kind === "pcs") return lc(await c.pub.readContract({ address: c.builder, abi: builderRead, functionName: "poolIdFor", args: [coin] }));
  const k = await c.pub.readContract({ address: c.builder, abi: v4KeyAbi, functionName: "poolKeyFor", args: [coin] });
  const enc = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]
  );
  return lc(keccak256(enc));
}

async function launchedAtOf(c, coin) {
  const abi = c.kind === "pcs" ? racesPcs : racesEth;
  const r = await c.pub.readContract({ address: c.builder, abi, functionName: "races", args: [coin] });
  return Number(c.kind === "pcs" ? r[3] : r[4]);
}

async function blockTimes(pub, numbers) {
  const out = new Map();
  await Promise.all(
    [...new Set(numbers.map(String))].map(async (n) => {
      const b = await pub.getBlock({ blockNumber: BigInt(n) });
      out.set(n, new Date(Number(b.timestamp) * 1000));
    })
  );
  return out;
}

const human = (v, dec) => formatUnits(v < 0n ? -v : v, dec);
const dollars6 = (v) => formatUnits(v, 6);
const fixed = (x) => (Number.isFinite(x) ? x.toFixed(6) : "0");
const sig = (x) => (Number.isFinite(x) && x > 0 ? x.toPrecision(15) : "0");

// ------------------------------------------------------------------ one batch of blocks

/**
 * Reads one batch of blocks from the chain (as few RPC calls as possible: one for all of
 * sasa's own contracts and the known coins, one for the coins' pool swaps, plus block times
 * and senders when needed), then writes it all in one database transaction.
 */
export async function raceRange(pool, c, byEid, from, to) {
  const { pub } = c;
  await prepare(c);

  // ---- RPC phase (no database transaction open while waiting on the chain)
  const before = await pool.query(
    `select r.coin_id, r.pool_id, k.coin, k.creator from race_chains r join race_coins k on k.id = r.coin_id where r.chain_id = $1`,
    [c.chainId]
  );
  const knownTokens = before.rows.map((r) => getAddress(r.coin));
  const own = [c.factory, c.hub, c.builder, c.router];
  const abi = [launchedEvt, ...hubEvts, ...builderEvts[c.kind], ...routerEvts, transferEvt];
  const raw = [];
  // own contracts + known coins in one call (in groups of 200 addresses)
  const addrs = [...own, ...knownTokens];
  for (let i = 0; i < addrs.length; i += 200) raw.push(...(await pub.getLogs({ address: addrs.slice(i, i + 200), fromBlock: from, toBlock: to })));
  let decoded = parseEventLogs({ abi, logs: raw, strict: true });
  const at = (a, name) => (l) => lc(l.address) === lc(a) && (Array.isArray(name) ? name.includes(l.eventName) : l.eventName === name);

  const launches = decoded.filter(at(c.factory, "Launched"));
  const launchInfo = [];
  for (const l of launches) {
    const coin = getAddress(l.args.coin);
    const poolId = await poolIdOf(c, coin);
    const launchedAt = await launchedAtOf(c, coin);
    launchInfo.push({ l, coin, poolId, launchedAt });
  }
  // coins launched in this very batch: their transfers too
  const knownSet = new Set(knownTokens.map(lc));
  const fresh = launchInfo.map((x) => x.coin).filter((a) => !knownSet.has(lc(a)));
  if (fresh.length) {
    const more = await pub.getLogs({ address: fresh, event: transferEvt, fromBlock: from, toBlock: to });
    decoded = decoded.concat(more);
  }
  const allTokens = new Set([...knownSet, ...fresh.map(lc)]);
  const hubLogsRaw = decoded.filter((l) => lc(l.address) === lc(c.hub) && ["ReportIn", "Decided", "Settled"].includes(l.eventName));
  const builderLogs = decoded.filter((l) => lc(l.address) === lc(c.builder) && builderEvts[c.kind].some((e) => e.name === l.eventName));
  const routerLogs = decoded.filter((l) => lc(l.address) === lc(c.router) && ["Bought", "Sold", "PoolTrade"].includes(l.eventName));
  const transferLogs = decoded.filter((l) => l.eventName === "Transfer" && allTokens.has(lc(l.address)));

  // swaps in the coins' pools: the pool manager is shared by every pool on the chain, so ask by pool id
  const poolIds = [...new Set([...before.rows.filter((r) => r.pool_id).map((r) => r.pool_id), ...launchInfo.map((x) => x.poolId)])];
  const swapLogs = [];
  const evt = c.kind === "pcs" ? swapEvt.pcs : swapEvt.v4;
  for (let i = 0; i < poolIds.length; i += 50)
    swapLogs.push(...(await pub.getLogs({ address: c.poolManager, event: evt, args: { id: poolIds.slice(i, i + 50) }, fromBlock: from, toBlock: to })));
  swapLogs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));

  // block times (launch, verdict, won/lost, swaps) and who sent swaps that didn't come through our router
  const needTime = [
    ...launches, ...hubLogsRaw.filter((l) => l.eventName === "Decided"),
    ...builderLogs.filter((l) => l.eventName === "RaceWon" || l.eventName === "RaceLost"), ...swapLogs,
  ].map((l) => l.blockNumber);
  const times = await blockTimes(pub, needTime);
  const viaRouter = new Map(routerLogs.map((r) => [lc(r.transactionHash), lc(r.args.buyer ?? r.args.seller ?? r.args.trader)]));
  const launchTx = new Map(launches.map((l) => [lc(l.transactionHash), lc(l.args.creator)]));
  const senders = new Map();
  for (const l of swapLogs) {
    const tx = lc(l.transactionHash);
    if (launchTx.has(tx) || viaRouter.has(tx) || lc(l.args.sender) === lc(c.builder) || senders.has(tx)) continue;
    senders.set(tx, lc((await pub.getTransaction({ hash: l.transactionHash })).from));
  }
  const usdPer = swapLogs.length ? await usdPerNative(c) : 1;

  // ---- database phase: everything in one transaction with the checkpoint
  const db = await pool.connect();
  try {
    await db.query("begin");

    for (const { l, coin, poolId, launchedAt } of launchInfo) {
      const a = l.args;
      const id = lc(a.coinId);
      const start = new Date(launchedAt * 1000);
      await db.query(
        `insert into race_coins (id, coin, creator, name, symbol, logo, description, fee_mode, eids, launched_at, ends_at, created_block)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do update set launched_at = least(race_coins.launched_at, excluded.launched_at),
                                        ends_at = greatest(race_coins.ends_at, excluded.ends_at)`,
        [id, lc(coin), lc(a.creator), a.name, a.symbol, a.logo, a.description, Number(a.feeMode), a.eids.map(Number), start,
         new Date((launchedAt + RACE_SECONDS) * 1000), l.blockNumber.toString()]
      );
      await db.query(
        `insert into race_chains (coin_id, chain_id, eid, seat, pool_id, native, launched_at, ends_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (coin_id, chain_id) do update set seat = excluded.seat, pool_id = excluded.pool_id,
                                                      launched_at = excluded.launched_at, ends_at = excluded.ends_at`,
        [id, c.chainId, c.eid, lc(a.seat), poolId, c.native, start, new Date((launchedAt + RACE_SECONDS) * 1000)]
      );
    }

    // Everything this chain knows about (including the launches just written).
    const known = await db.query(
      `select r.coin_id, r.pool_id, k.coin, k.creator from race_chains r join race_coins k on k.id = r.coin_id where r.chain_id = $1`,
      [c.chainId]
    );
    const byCoin = new Map(known.rows.map((r) => [r.coin, r]));
    const byPool = new Map(known.rows.filter((r) => r.pool_id).map((r) => [r.pool_id, r]));
    const ids = new Set(known.rows.map((r) => r.coin_id));

    // 2. Hub: chain reports, the verdict, each chain's settlement. The verdict is on the
    //    coordinator's chain, which need not be in the race: match coins known on any chain.
    //    (A row another chain hasn't indexed yet is filled in by RaceWon/RaceLost below.)
    if (hubLogsRaw.length) {
      const seen = await db.query("select id from race_coins where id = any($1)", [[...new Set(hubLogsRaw.map((l) => lc(l.args.coin)))]]);
      const anyIds = new Set(seen.rows.map((r) => r.id));
      for (const l of hubLogsRaw.filter((x) => anyIds.has(lc(x.args.coin)))) {
        const a = l.args;
        const id = lc(a.coin);
        if (l.eventName === "ReportIn") {
          const chainId = byEid.get(Number(a.eid));
          if (chainId !== undefined)
            await db.query("update race_chains set reported_usd = $3, updated_at = now() where coin_id = $1 and chain_id = $2", [id, chainId, dollars6(a.money)]);
        } else if (l.eventName === "Decided") {
          await db.query(
            "update race_coins set winner_eid = $2, winner_chain = $3, total_usd = $4, decided_at = $5 where id = $1",
            [id, Number(a.winner), byEid.get(Number(a.winner)) ?? null, dollars6(a.total), times.get(String(l.blockNumber))]
          );
        } else if (l.eventName === "Settled" && ids.has(id)) {
          await db.query("update race_chains set state = $3, updated_at = now() where coin_id = $1 and chain_id = $2", [id, c.chainId, a.isWinner ? WON : LOST]);
        }
      }
    }

    // 3. Builder: report (this chain's own number), won / lost, hand-over, fees.
    const nd = nativeDecimals(c);
    for (const l of builderLogs.filter((x) => byCoin.has(lc(x.args.coin)))) {
      const k = byCoin.get(lc(l.args.coin));
      const a = l.args;
      if (l.eventName === "RaceReported") {
        const usd = c.kind === "usdc" ? formatUnits(a.poolUsdc, c.usdDecimals) : dollars6(a.dollars);
        const nat = c.kind === "usdc" ? usd : human(c.kind === "eth" ? a.poolEth : a.poolBnb, 18);
        await db.query(
          "update race_chains set reported_usd = coalesce(reported_usd, $3), pool_native = $4, pool_usd = $3, updated_at = now() where coin_id = $1 and chain_id = $2",
          [k.coin_id, c.chainId, usd, nat]
        );
      } else if (l.eventName === "RaceWon" || l.eventName === "RaceLost") {
        // Every chain of the race learns the winner: fill it in if the verdict isn't indexed yet.
        const w = Number(a.winnerEid);
        await db.query(
          "update race_coins set winner_eid = $2, winner_chain = $3, decided_at = coalesce(decided_at, $4) where id = $1 and winner_eid is null",
          [k.coin_id, w, byEid.get(w) ?? null, times.get(String(l.blockNumber))]
        );
      }
      if (l.eventName === "RaceWon") {
        await db.query("update race_chains set state = $3, updated_at = now() where coin_id = $1 and chain_id = $2", [k.coin_id, c.chainId, WON]);
      } else if (l.eventName === "RaceLost") {
        await db.query("update race_chains set state = $3, pool_native = 0, pool_usd = 0, updated_at = now() where coin_id = $1 and chain_id = $2", [k.coin_id, c.chainId, LOST]);
        if (c.kind === "usdc") await db.query("update race_chains set handed_over = true where coin_id = $1 and chain_id = $2", [k.coin_id, c.chainId]);
      } else if (l.eventName === "HandedOver") {
        await db.query("update race_chains set handed_over = true, updated_at = now() where coin_id = $1 and chain_id = $2", [k.coin_id, c.chainId]);
      } else if (l.eventName === "FeesCollected") {
        const f = c.kind === "eth" ? a.ethFees : c.kind === "pcs" ? a.bnbFees : a.usdcFees;
        const ins = await db.query(
          `insert into race_fees (chain_id, tx_hash, log_index, coin_id, native_amount, coin_amount) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning 1`,
          [c.chainId, lc(l.transactionHash), l.logIndex, k.coin_id, human(f, nd), human(a.coinFees, 18)]
        );
        if (ins.rowCount)
          await db.query("update race_chains set fees_native = fees_native + $3 where coin_id = $1 and chain_id = $2", [k.coin_id, c.chainId, human(f, nd)]);
      }
    }

    // 4. Swaps in the coins' pools (every router and bot), with the trader from our router when it was ours.
    let swaps = 0;
    for (const l of swapLogs) {
      const k = byPool.get(lc(l.args.id));
      if (!k) continue;
      const tx = lc(l.transactionHash);
      // currency0 is the native coin on ETH/BNB pools; on dollar pools it is whichever address is lower.
      const nativeIs0 = c.kind !== "usdc" || BigInt(c.usd) < BigInt(k.coin);
      const dn = nativeIs0 ? l.args.amount0 : l.args.amount1;
      const dc = nativeIs0 ? l.args.amount1 : l.args.amount0;
      if (dn === 0n || dc === 0n) continue;
      const isBuy = dn < 0n; // the swapper paid native in
      const nat = Number(human(dn, nd));
      const tok = Number(human(dc, 18));
      const usd = nat * usdPer;
      const price = tok > 0 ? usd / tok : 0;
      let trader, via;
      if (launchTx.has(tx)) {
        trader = launchTx.get(tx); via = "launch";
      } else if (viaRouter.has(tx)) {
        trader = viaRouter.get(tx); via = "sasa";
      } else if (lc(l.args.sender) === lc(c.builder)) {
        trader = lc(c.builder); via = "system";
      } else {
        trader = senders.get(tx); via = "pool";
      }
      const ins = await db.query(
        `insert into race_trades (chain_id, tx_hash, log_index, block_number, ts, coin_id, trader, is_buy, native_amount, token_amount, usd_amount, price_usd, via)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing returning 1`,
        [c.chainId, tx, l.logIndex, l.blockNumber.toString(), times.get(String(l.blockNumber)), k.coin_id, trader, isBuy,
         human(dn, nd), human(dc, 18), fixed(usd), sig(price), via]
      );
      if (ins.rowCount && via !== "system") {
        await db.query(
          `update race_chains set buys = buys + $3, sells = sells + $4, volume_usd = volume_usd + $5, price_usd = $6, updated_at = now()
           where coin_id = $1 and chain_id = $2`,
          [k.coin_id, c.chainId, isBuy ? 1 : 0, isBuy ? 0 : 1, fixed(usd), sig(price)]
        );
      }
      swaps++;
    }

    // 5. Coin transfers -> balances (holders). Each transfer is applied once.
    for (const l of transferLogs) {
      const a = l.args;
      const ins = await db.query(
        `insert into transfers (chain_id, tx_hash, log_index, token, from_addr, to_addr, amount) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning 1`,
        [c.chainId, l.transactionHash, l.logIndex, lc(l.address), lc(a.from), lc(a.to), a.value.toString()]
      );
      if (!ins.rowCount || a.value === 0n) continue;
      for (const [holder, delta] of [[lc(a.from), `-${a.value}`], [lc(a.to), a.value.toString()]]) {
        if (holder === ZERO) continue;
        await db.query(
          `insert into balances (chain_id, token, holder, amount) values ($1,$2,$3,$4)
           on conflict (chain_id, token, holder) do update set amount = balances.amount + excluded.amount`,
          [c.chainId, lc(l.address), holder, delta]
        );
      }
    }

    await db.query(
      `insert into race_state (chain_id, last_block) values ($1,$2) on conflict (chain_id) do update set last_block = excluded.last_block`,
      [c.chainId, to.toString()]
    );
    await db.query("commit");
    return { launches: launches.length, swaps, transfers: transferLogs.length };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

// ------------------------------------------------------------------ loops

/** Follows one chain. `once`: stop when caught up with the tip. */
async function runRaceChain(pool, c, byEid, log, once = false) {
  let range = MAX_RANGE;
  let fails = 0;
  for (;;) {
    try {
      const st = await pool.query("select last_block from race_state where chain_id = $1", [c.chainId]);
      const from = st.rowCount ? BigInt(st.rows[0].last_block) + 1n : c.startBlock;
      const tip = (await c.pub.getBlockNumber()) - CONFIRMATIONS;
      if (from > tip) {
        if (once) return;
        await sleep(POLL_MS);
        continue;
      }
      const to = from + range - 1n > tip ? tip : from + range - 1n;
      const r = await raceRange(pool, c, byEid, from, to);
      if (r.launches || r.swaps) log(`race ${c.chainId} ${from}-${to}: ${r.launches} launches, ${r.swaps} swaps, ${r.transfers} transfers`);
      fails = 0;
      if (range < MAX_RANGE) range = range * 2n > MAX_RANGE ? MAX_RANGE : range * 2n;
      if (to === tip && !once) await sleep(POLL_MS);
    } catch (e) {
      // A rate limit (some RPCs word it "exceeds defined limit" even for a few blocks): wait and
      // try the same blocks again. Anything else at a wide range: too many logs, take smaller steps.
      fails++;
      const msg = [e.shortMessage, e.details, e.message, e.cause?.details].filter(Boolean).join(" ");
      const rateLimited = /rate limit|429|too many|exceeds defined limit|limit exceeded/i.test(msg);
      if (!rateLimited || range > 500n) range = range > 10n ? range / 4n : 10n;
      log(`race ${c.chainId}: ${e.shortMessage ?? e.message} (${rateLimited && range <= 500n ? "waiting, then" : "retrying with"} ${range} blocks)`);
      if (once && fails > 60) throw e;
      await sleep(Math.min(2_000 * fails, 20_000));
    }
  }
}

/** During a race: each chain's pool money, read straight from the builder every few seconds. */
async function liveRaceMoney(pool, chains, log) {
  const byChain = new Map(chains.map((c) => [c.chainId, c]));
  for (;;) {
    try {
      const r = await pool.query(
        `select r.coin_id, r.chain_id, k.coin from race_chains r join race_coins k on k.id = r.coin_id
         where r.state = 1 and r.reported_usd is null and k.launched_at > now() - interval '20 minutes'`
      );
      for (const row of r.rows) {
        const c = byChain.get(row.chain_id);
        if (!c) continue;
        try {
          await prepare(c);
          const [nat] = await c.pub.readContract({ address: c.builder, abi: builderRead, functionName: "poolAmounts", args: [getAddress(row.coin)] });
          const natH = Number(formatUnits(nat, nativeDecimals(c)));
          const usd = natH * (await usdPerNative(c));
          await pool.query("update race_chains set pool_native = $3, pool_usd = $4, updated_at = now() where coin_id = $1 and chain_id = $2 and reported_usd is null", [
            row.coin_id, row.chain_id, natH.toString(), fixed(usd),
          ]);
        } catch (e) {
          // one chain's RPC hiccup: the next tick tries again
        }
      }
    } catch (e) {
      log(`race live money: ${e.message}`);
    }
    await sleep(LIVE_MS);
  }
}

/** Started by indexer.mjs. Does nothing when no race chain has an RPC. */
export async function raceLoop(pool, log) {
  const { chains, byEid } = loadRaceChains(log);
  if (!chains.length) return;
  try {
    await pool.query("select 1 from race_state limit 1");
  } catch {
    log("race indexer: run indexer/race.sql in Supabase first; race indexing is off until then");
    return;
  }
  await Promise.all([...chains.map((c) => runRaceChain(pool, c, byEid, log)), liveRaceMoney(pool, chains, log)]);
}

// ------------------------------------------------------------------ standalone

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const url = env("DATABASE_URL");
  if (!url) throw new Error("missing env DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 8, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const { chains, byEid } = loadRaceChains(log);
  if (!chains.length) throw new Error("no race chain has an RPC (set RPC_<chainId>)");
  if (env("RACE_ONCE", "false") === "true") {
    Promise.all(chains.map((c) => runRaceChain(pool, c, byEid, log, true)))
      .then(async () => {
        log("race indexer: every chain caught up");
        await pool.end();
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    raceLoop(pool, log).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
