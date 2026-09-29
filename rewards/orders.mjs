// Auto orders keeper: watches every open SasaOrders order and fills it the
// moment the market is inside its window. The contract checks the window
// itself, so this can only ever help: a fill outside it simply reverts.
//
// Checks are cheap first (on the curve: quoteSell / quoteBuy), then the fill
// is simulated, and only then sent. Graduated coins (no quote on the curve)
// are simulated every 30 seconds. The owner gets a 🔔 when it fills.

import { getAddress, parseAbi } from "viem";

const ordersAbi = parseAbi([
  "function nextId() view returns (uint256)",
  "function orders(uint256 id) view returns (address owner, address curve, address token, address router, bool isBuy, bool open, uint64 expiry, uint256 amount, uint256 minOut, uint256 maxOut)",
  "function execute(uint256 id) returns (uint256)",
]);
const curveAbi = parseAbi([
  "function state() view returns (uint8)",
  "function quoteSell(uint256) view returns (uint256)",
  "function quoteBuy(uint256) view returns (uint256)",
  "function tokensForSale() view returns (uint256)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const MAX = 2n ** 256n - 1n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param c chain with pub, wallet, orders (address) */
export async function ordersLoop(c, pool, log, account) {
  if (!c.orders) return;
  const site = (process.env.SITE_URL ?? "https://sasapad.fun").replace(/\/$/, "");
  const every = Number(process.env.ORDERS_EVERY_MS ?? "8000");
  const open = new Map(); // id -> order
  let seen = 0n; // ids below this have been read once
  const lastSim = new Map(); // id -> ms, for graduated / stubborn orders
  log(`${c.name}: watching auto orders at ${c.orders}`);

  for (;;) {
    try {
      const next = await c.pub.readContract({ address: c.orders, abi: ordersAbi, functionName: "nextId" });
      for (let id = seen === 0n ? 1n : seen; id < next; id++) open.set(id, null); // new ids: read below
      seen = next;

      for (const id of [...open.keys()]) {
        const r = await c.pub.readContract({ address: c.orders, abi: ordersAbi, functionName: "orders", args: [id] });
        const o = { id, owner: r[0], curve: r[1], token: r[2], router: r[3], isBuy: r[4], open: r[5], expiry: r[6], amount: r[7], minOut: r[8], maxOut: r[9] };
        if (!o.open || (o.expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) > o.expiry)) {
          open.delete(id);
          continue;
        }
        open.set(id, o);
        if (await ready(c, o, lastSim)) await fill(c, o, pool, log, account, site);
      }
    } catch (e) {
      log(`${c.name} orders: ${e.shortMessage ?? e.message}`);
    }
    await sleep(every);
  }
}

/** Cheap check: would this order fill right now? */
async function ready(c, o, lastSim) {
  const st = await c.pub.readContract({ address: o.curve, abi: curveAbi, functionName: "state" });
  if (Number(st) === 1 && o.isBuy) return false; // closed curve: no buys
  if (Number(st) === 2) {
    // Pool: no quote on the curve, so try a simulated fill now and then.
    const t = lastSim.get(o.id) ?? 0;
    if (Date.now() - t < 30_000) return false;
    lastSim.set(o.id, Date.now());
    return simulate(c, o);
  }
  if (o.isBuy) {
    const left = await c.pub.readContract({ address: o.curve, abi: curveAbi, functionName: "tokensForSale" });
    if (left === 0n) return false;
    const out = await c.pub.readContract({ address: o.curve, abi: curveAbi, functionName: "quoteBuy", args: [o.amount] });
    if (out < o.minOut || out > o.maxOut) return false;
  } else {
    const [bal, allow] = await Promise.all([
      c.pub.readContract({ address: o.token, abi: tokenAbi, functionName: "balanceOf", args: [o.owner] }),
      c.pub.readContract({ address: o.token, abi: tokenAbi, functionName: "allowance", args: [o.owner, c.orders] }),
    ]);
    let amt = o.amount;
    if (bal < amt) amt = bal;
    if (allow < amt) amt = allow;
    if (amt === 0n) return false;
    const out = await c.pub.readContract({ address: o.curve, abi: curveAbi, functionName: "quoteSell", args: [amt] });
    const min = (o.minOut * amt) / o.amount || 1n;
    const max = o.maxOut === MAX ? MAX : (o.maxOut * amt) / o.amount;
    if (out < min || out > max) return false;
  }
  return simulate(c, o);
}

async function simulate(c, o) {
  try {
    await c.pub.simulateContract({ account: c.wallet.account, address: c.orders, abi: ordersAbi, functionName: "execute", args: [o.id] });
    return true;
  } catch {
    return false;
  }
}

async function fill(c, o, pool, log, account, site) {
  if (process.env.DRY_RUN === "1") {
    log(`[dry] ${c.name}: would fill order ${o.id}`);
    return;
  }
  const hash = await c.wallet.writeContract({ address: c.orders, abi: ordersAbi, functionName: "execute", args: [o.id], account });
  const receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    log(`${c.name}: order ${o.id} fill reverted (${hash}); will keep watching`);
    return;
  }
  const kind = o.isBuy ? "dip" : o.maxOut === MAX ? "tp" : "sl";
  log(`${c.name}: filled ${kind} order ${o.id} for ${o.owner} (${hash})`);
  try {
    const { rows } = await pool.query(
      "select c.id, c.symbol from curves k join coins c on c.id = k.coin_id where k.chain_id = $1 and k.curve = $2",
      [c.chainId, o.curve.toLowerCase()]
    );
    const coin = rows[0];
    const sym = coin ? `$${coin.symbol}` : "your coin";
    const title =
      kind === "tp" ? `🎯 Take profit hit: sold ${sym}` : kind === "sl" ? `🛡 Stop loss: sold ${sym}` : `🪝 Bought the dip on ${sym}`;
    await pool.query(
      `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
       values ($1, $2, 'order', $3, $4, $5, false)`,
      [
        getAddress(o.owner).toLowerCase(),
        coin?.id ?? null,
        title,
        "Your auto order filled. Tap to see the coin.",
        coin ? `${site}/coin/?id=${encodeURIComponent(coin.id)}` : `${site}/me/`,
      ]
    );
  } catch (e) {
    log(`${c.name}: order ${o.id} filled, but the notification failed: ${e.message}`);
  }
}
