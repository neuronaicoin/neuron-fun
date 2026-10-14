/**
 * Checks the race coin page's trade path (components/racetrade.tsx) on a fork of a race chain:
 * the same addresses and ABIs (lib/race.ts), the same steps (approve, dry run, trade with the
 * user's slippage). Run by .github/workflows/race-trade-fork.yml against anvil:
 *
 *   npx tsx scripts/race-trade-fork.mts <chainId> http://127.0.0.1:8545
 *
 * Uses anvil's first test account; nothing is sent to a real network.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  maxUint256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { call } from "../lib/tx";
import { RACE_CHAINS, bestLinkedGroup, chainsLinked, fetchRaceLinks, raceChain, raceErc20Abi, raceFactoryAbi, raceRouterAbi } from "../lib/race";

const [chainIdArg, rpc] = process.argv.slice(2);
const c = raceChain(Number(chainIdArg));
if (!c || !rpc) throw new Error("usage: race-trade-fork.mts <chainId> <rpc>");
const dep = JSON.parse(readFileSync(new URL(`../../contracts-v7/deployments/race/${c.chainId}.json`, import.meta.url), "utf8"));

// anvil's well-known first test account (public, holds only fork money)
const me = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = { ...c.chain, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: me, chain, transport: http(rpc) });

const factoryAbi = raceFactoryAbi;

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};
async function send(to: Address, data: Hex) {
  const hash = await wallet.sendTransaction({ to, data, account: me, chain });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") {
    // why: the call tree of the failed transaction (anvil), and gas used against the limit
    const tx = await pub.getTransaction({ hash });
    console.log(`   reverted ${hash}: gas used ${r.gasUsed} of limit ${tx.gas}`);
    try {
      const trace = (await pub.request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "callTracer" }] as never })) as Record<string, unknown>;
      const walk = (n: Record<string, unknown>, depth: number) => {
        if (depth > 6) return;
        if (n.error || n.revertReason)
          console.log(`   ${"  ".repeat(depth)}${n.type} ${n.to} gas ${n.gas} used ${n.gasUsed}: ${n.error ?? ""} ${n.revertReason ?? ""} ${String(n.output ?? "").slice(0, 138)}`);
        for (const k of (n.calls as Record<string, unknown>[] | undefined) ?? []) walk(k, depth + 1);
      };
      walk(trace, 0);
    } catch (e) {
      console.log(`   (no trace: ${(e as Error).message.split("\n")[0]})`);
    }
    // the same call again on the state after that block, for a decoded reason
    try {
      await pub.call({ account: me, to, data, blockNumber: r.blockNumber });
      console.log("   the same call succeeds on the next state: likely an out-of-gas or timing failure");
    } catch (e) {
      console.log(`   replay: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]}`);
    }
    throw new Error(`reverted: ${hash}`);
  }
  return r;
}
const bal = (token: Address) => pub.readContract({ address: token, abi: raceErc20Abi, functionName: "balanceOf", args: [me.address] }) as Promise<bigint>;
const deadline = async () => (await pub.getBlock()).timestamp + 600n;

/** The exact steps of RaceTradeBox.submit. */
async function trade(side: "buy" | "sell", coin: Address, amountIn: bigint, slipBps = 500n) {
  const token = side === "buy" ? c!.usd : coin;
  const allowance = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [me.address, c!.router] })) as bigint;
  if (allowance < amountIn) {
    const a = call(token, raceErc20Abi, "approve", [c!.router, maxUint256]);
    await send(a.to, a.data);
  }
  const sim = await pub.simulateContract({ account: me, address: c!.router, abi: raceRouterAbi, functionName: side, args: [coin, amountIn, 0n, me.address, await deadline()] });
  const out = sim.result as bigint;
  const minOut = (out * (10_000n - slipBps)) / 10_000n;
  const t = call(c!.router, raceRouterAbi, side, [coin, amountIn, minOut, me.address, await deadline()]);
  await send(t.to, t.data);
  return { out, minOut };
}

async function main() {
  console.log(`== ${c!.name} (${c!.chainId}) router ${c!.router} usd ${c!.usd}`);
  ok(dep.router.toLowerCase() === c!.router.toLowerCase(), "lib/race.ts router matches contracts-v7 deployment");
  ok(dep.usd.toLowerCase() === c!.usd.toLowerCase(), "lib/race.ts dollar matches contracts-v7 deployment");
  ok(dep.eid === c!.eid, "lib/race.ts eid matches contracts-v7 deployment");
  ok(dep.factory.toLowerCase() === c!.factory.toLowerCase(), "lib/race.ts factory matches contracts-v7 deployment");
  for (const k of ["poolManager", "clPoolManager", "vault", "builder", "hook", "consolidator", "bridge"]) {
    const a = dep[k] as string;
    if (a && a !== "0x0000000000000000000000000000000000000000")
      ok(c!.system.some((s) => s.toLowerCase() === a.toLowerCase()), `${k} is left out of holders`);
  }

  // 1. test dollars from the faucet (the page's "Get $100 test USDC" button)
  const f = call(c!.usd, raceErc20Abi, "faucet", [me.address]);
  await send(f.to, f.data);
  const dec = Number(await pub.readContract({ address: c!.usd, abi: raceErc20Abi, functionName: "decimals" }));
  const usd0 = await bal(c!.usd);
  ok(usd0 >= 100n * 10n ** BigInt(dec), `faucet gave $${formatUnits(usd0, dec)}`);

  // 2. launch like the page: the biggest group of linked chains that includes this one, $5 first buy
  //    (links are read from the real testnets, as the page does)
  const links = await fetchRaceLinks();
  const mine = links.get(c!.chainId);
  ok(!!mine && mine.size > 0, `${c!.short} is linked to: ${[...(mine ?? [])].map((id) => raceChain(id)!.short).join(", ")}`);
  const group = [c!.chainId, ...RACE_CHAINS.map((x) => x.chainId).filter((id) => id !== c!.chainId && mine?.has(id))];
  // drop chains until every pair in the group is linked (as bestLinkedGroup does for the page)
  while (group.length > 2 && !chainsLinked(group, links)) group.pop();
  ok(chainsLinked(group, links), `racing on ${group.map((id) => raceChain(id)!.short).join(" + ")}`);
  console.log(`   the page's default group: ${bestLinkedGroup(links).map((id) => raceChain(id)!.short).join(" + ")}`);
  const key = keccak256(toHex(`race-trade-fork-${Date.now()}`));
  const coin = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "coinAddress", args: [me.address, key] })) as Address;
  const minFirst = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "minFirstBuy" })) as bigint;
  const ap = call(c!.usd, raceErc20Abi, "approve", [dep.factory, minFirst]);
  await send(ap.to, ap.data);
  const ln = call(dep.factory, factoryAbi as never, "launch", [
    { name: "Fork Test", symbol: "FORK", logo: "", description: "", launchKey: key, eids: group.map((id) => raceChain(id)!.eid).sort((a, b) => a - b), feeMode: 0, firstBuy: minFirst, minCoinsOut: 0n },
  ]);
  await send(ln.to, ln.data);
  const firstCoins = await bal(coin);
  ok(firstCoins > 0n, `launched ${coin}, creator holds ${formatUnits(firstCoins, 18)} after the first buy`);

  // 3. buy $10 during the race (opening fee)
  const coins0 = await bal(coin);
  const b1 = await trade("buy", coin, 10n * 10n ** BigInt(dec));
  const got1 = (await bal(coin)) - coins0;
  // During the first five minutes the pool fee falls every second, so a trade that lands a
  // second after its dry run gets slightly more, never less.
  console.log(`   dry run ${formatUnits(b1.out, 18)} / got ${formatUnits(got1, 18)}`);
  ok(got1 >= b1.out && got1 <= (b1.out * 103n) / 100n, `buy $10 → ${formatUnits(got1, 18)} coins: at least the dry run's amount, at most 3% more`);
  ok(got1 >= b1.minOut, "got at least the minimum (5% slippage)");

  // 4. a minimum above the real amount must be refused (slippage protection works)
  let refused = false;
  try {
    const sim = await pub.simulateContract({ account: me, address: c!.router, abi: raceRouterAbi, functionName: "buy", args: [coin, 10n ** BigInt(dec), maxUint256 / 2n, me.address, await deadline()] });
    void sim;
  } catch (e) {
    refused = /Slippage/.test(String((e as Error).message));
  }
  ok(refused, "a buy whose minimum can't be met is refused with Slippage");

  // 5. sell half
  const usdBefore = await bal(c!.usd);
  const half = (await bal(coin)) / 2n;
  const s1 = await trade("sell", coin, half);
  const usdGot = (await bal(c!.usd)) - usdBefore;
  console.log(`   dry run $${formatUnits(s1.out, dec)} / got $${formatUnits(usdGot, dec)}`);
  ok(usdGot > 0n && usdGot >= s1.out && usdGot <= (s1.out * 103n) / 100n, `sell half → $${formatUnits(usdGot, dec)}: at least the dry run's amount`);

  // 6. after five minutes the pool fee is down to 2%: the same $10 buys more coins
  await pub.request({ method: "evm_increaseTime" as never, params: [301] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
  const coins2 = await bal(coin);
  const b2 = await trade("buy", coin, 10n * 10n ** BigInt(dec));
  const got2 = (await bal(coin)) - coins2;
  ok(got2 >= b2.out && got2 <= (b2.out * 103n) / 100n, `buy $10 after 5 min → ${formatUnits(got2, 18)} coins`);

  // 7. sell everything
  const all = await bal(coin);
  await trade("sell", coin, all);
  ok((await bal(coin)) === 0n, "sold everything, coin balance is 0");

  console.log(failures ? `${failures} check(s) failed` : `${c!.name}: all checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
