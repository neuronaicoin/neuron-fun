// Checks the race tables against the chains themselves. Used by the "race indexer check"
// workflow after `RACE_ONCE=true node race.mjs`; safe to run against the live database too
// (read-only). Exits 1 when anything disagrees.
//
// For every coin and chain:
//   - the chain's race state (racing / won / lost) matches the builder's
//   - the winner matches what the coin's seat says
//   - a race that is over has its official money (reported_usd)
//   - the creator's first buy was indexed (so the pool id is right)
//   - holders: the indexed balances add up to the coin's total supply on that chain, none negative
// Env: DATABASE_URL, RPC_<chainId> (as race.mjs)

import pg from "pg";
import { formatUnits, getAddress, parseAbi } from "viem";
import { loadRaceChains } from "./race.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("missing env DATABASE_URL");
const pool = new pg.Pool({ connectionString: url, max: 4, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
const { chains } = loadRaceChains(() => {});
const byChain = new Map(chains.map((c) => [c.chainId, c]));

const racesEth = parseAbi(["function races(address) view returns (uint256, address, address, uint8, uint64, uint8 state, uint32 winnerEid)"]);
const racesPcs = parseAbi(["function races(address) view returns (address, address, uint8, uint64, uint8 state, uint32 winnerEid, int24, int24)"]);
const seatAbi = parseAbi(["function winnerEid() view returns (uint32)"]);
const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

// Read the chain at the block the indexer reached (it stays a few blocks behind the tip).
const lastBlock = new Map((await pool.query("select chain_id, last_block from race_state")).rows.map((r) => [r.chain_id, BigInt(r.last_block)]));
async function readAt(c, args) {
  try {
    return await c.pub.readContract({ ...args, blockNumber: lastBlock.get(c.chainId) });
  } catch {
    return c.pub.readContract(args); // a node that keeps no history: the tip is a few blocks later at most
  }
}

const bad = [];
const rows = [];
const fail = (what) => bad.push(what);

const coins = (await pool.query("select * from race_coins order by launched_at")).rows;
const chainRows = (await pool.query("select * from race_chains")).rows;
console.log(`${coins.length} race coins, ${chainRows.length} coin-chain rows`);
if (coins.length === 0) fail("no race coins indexed at all");

for (const k of coins) {
  const mine = chainRows.filter((r) => r.coin_id === k.id);
  if (mine.length !== k.eids.length) console.log(`note: ${k.symbol} ${k.id.slice(0, 10)} lists ${k.eids.length} chains, ${mine.length} launched (a launch on one chain can fail on its own)`);
  for (const r of mine) {
    const c = byChain.get(r.chain_id);
    if (!c) continue;
    const coin = getAddress(k.coin);
    const tag = `${k.symbol} ${k.id.slice(0, 10)} on ${r.chain_id}`;
    const res = await readAt(c, { address: c.builder, abi: c.kind === "pcs" ? racesPcs : racesEth, functionName: "races", args: [coin] });
    const chainState = Number(c.kind === "pcs" ? res[4] : res[5]);
    if (chainState !== r.state) fail(`${tag}: state is ${chainState} on chain, ${r.state} indexed`);
    const seatWinner = Number(await readAt(c, { address: getAddress(r.seat), abi: seatAbi, functionName: "winnerEid" }));
    if (seatWinner !== 0 && seatWinner !== (k.winner_eid ?? 0)) fail(`${tag}: seat says winner ${seatWinner}, indexed ${k.winner_eid}`);
    if (chainState !== 1 && r.reported_usd === null) fail(`${tag}: race over but no reported money indexed`);
    const launchBuys = (await pool.query("select count(*)::int n from race_trades where coin_id = $1 and chain_id = $2 and via = 'launch'", [k.id, r.chain_id])).rows[0].n;
    if (launchBuys !== 1) fail(`${tag}: ${launchBuys} creator first buys indexed (expected 1: is the pool id right?)`);
    const supply = await readAt(c, { address: coin, abi: supplyAbi, functionName: "totalSupply" });
    const b = (await pool.query(
      "select coalesce(sum(amount),0)::text total, count(*) filter (where amount < 0)::int neg, count(*) filter (where amount > 0)::int holders from balances where chain_id = $1 and token = $2",
      [r.chain_id, k.coin]
    )).rows[0];
    if (BigInt(b.total) !== supply) fail(`${tag}: balances add up to ${b.total}, total supply is ${supply}`);
    if (b.neg > 0) fail(`${tag}: ${b.neg} negative balances`);
    const t = (await pool.query("select count(*)::int n from race_trades where coin_id = $1 and chain_id = $2", [k.id, r.chain_id])).rows[0].n;
    rows.push(
      `${tag} | state ${r.state} | reported $${r.reported_usd ?? "-"} | ${t} trades (${r.buys} buys / ${r.sells} sells) | ${b.holders} holders | supply ${formatUnits(supply, 18)}`
    );
  }
  if (k.winner_eid !== null && !mine.some((r) => r.eid === k.winner_eid)) fail(`${k.symbol} ${k.id.slice(0, 10)}: winner ${k.winner_eid} is not one of its indexed chains`);
}

console.log(rows.join("\n"));
await pool.end();
if (bad.length) {
  console.log(`\n${bad.length} PROBLEM(S):\n- ${bad.join("\n- ")}`);
  process.exit(1);
}
console.log("\nEverything matches the chains.");
