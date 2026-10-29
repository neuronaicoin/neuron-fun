// Where sasa runs on Elysium mainnet: the file the "Deploy sasa launcher on Elysium" workflow
// writes on mainnet day (web/lib/elysium-mainnet.json). Read from the repo when the indexer has
// it, else from the live site (web/public/elysium-mainnet.json, the same file). null = not yet.

import { readFileSync } from "node:fs";
import { getAddress } from "viem";

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

function parse(j) {
  if (!j || !j.chainId || !j.rpc || !isAddr(j.launcher)) return null;
  return {
    chainId: Number(j.chainId),
    rpc: process.env.ELYSIUM_RPC || j.rpc,
    launcher: getAddress(j.launcher),
    pass: isAddr(j.pass) ? getAddress(j.pass) : null,
    /** Unix seconds the launcher went live (the 3x points week starts here). */
    start: Number(j.start) || null,
    /** A block from just before the deploy (the scan starts here). */
    startBlock: j.startBlock ? BigInt(j.startBlock) : null,
  };
}

export async function elysiumMainnet() {
  try {
    const j = JSON.parse(readFileSync(new URL("../web/lib/elysium-mainnet.json", import.meta.url), "utf8"));
    const c = parse(j);
    if (c) return c;
  } catch {
    // not in this checkout: ask the site
  }
  try {
    const r = await fetch(`https://sasapad.fun/elysium-mainnet.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) return parse(await r.json());
  } catch {
    // site unreachable: try again later
  }
  return null;
}
