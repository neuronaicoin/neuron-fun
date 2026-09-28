import type { Address } from "viem";
import { curveAbi } from "./abis";
import type { ContractSet, NeuronChain } from "./config";
import { clientFor } from "./data";

/**
 * Each coin belongs to the contract set that launched it. New coins use the
 * chain's live set; coins from an earlier set keep their own router and
 * migrator. A curve names its migrator on-chain, so we ask it once and cache.
 */
const cache = new Map<string, Promise<Address>>();
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function allSets(chain: NeuronChain): ContractSet[] {
  return [{ factory: chain.factory, router: chain.router, migrator: chain.migrator }, ...(chain.legacy ?? [])];
}

function migratorOf(chain: NeuronChain, curve: Address): Promise<Address> {
  const key = `${chain.chain.id}:${curve.toLowerCase()}`;
  let p = cache.get(key);
  if (!p) {
    p = (clientFor(chain).readContract({ address: curve, abi: curveAbi, functionName: "migrator" }) as Promise<Address>).catch(
      (e) => {
        cache.delete(key); // try again next time
        throw e;
      }
    );
    cache.set(key, p);
  }
  return p;
}

/** The contract set a curve belongs to (the live set if it can't be read). */
export async function setOf(c: { chain: NeuronChain; curve: Address }): Promise<ContractSet & { live: boolean }> {
  const sets = allSets(c.chain);
  try {
    const m = await migratorOf(c.chain, c.curve);
    const i = sets.findIndex((s) => eq(s.migrator, m));
    if (i >= 0) return { ...sets[i], live: i === 0 };
  } catch {
    // fall through to the live set
  }
  return { ...sets[0], live: true };
}

export const routerOf = async (c: { chain: NeuronChain; curve: Address }) => (await setOf(c)).router;
export const migratorFor = async (c: { chain: NeuronChain; curve: Address }) => (await setOf(c)).migrator;
