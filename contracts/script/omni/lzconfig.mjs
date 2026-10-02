// Prints the LayerZero settings for one mainnet chain as KEY=value lines (for $GITHUB_ENV),
// read live from LayerZero's own registry: endpoint, eid, send/receive libraries, executor
// and two independent verifiers (DVNs) that run on every chain of ours.
//   node lzconfig.mjs <chainId> [<otherChainId> ...]   -> settings for the first chain id
const ids = process.argv.slice(2).map(Number);
if (!ids.length) throw new Error("usage: node lzconfig.mjs <chainId> [<otherChainId> ...]");
// Verifier providers we use, in order of preference; the first two found on every chain win.
const PREFERRED = ["layerzero-labs", "nethermind", "horizen-labs", "p2p", "canary"];

const res = await fetch("https://metadata.layerzero-api.com/v1/metadata/deployments");
if (!res.ok) throw new Error(`LayerZero registry: HTTP ${res.status}`);
const all = await res.json();

function chainOf(id) {
  const entry = Object.values(all).find((c) => c?.chainDetails?.nativeChainId === id && c.deployments?.some((d) => d.version === 2 && d.stage === "mainnet"));
  if (!entry) throw new Error(`chain ${id} not in the LayerZero registry`);
  const d = entry.deployments.find((x) => x.version === 2 && x.stage === "mainnet");
  // One active, non-lzRead DVN per provider.
  const dvns = {};
  for (const [addr, v] of Object.entries(entry.dvns ?? {})) {
    if (v.version !== 2 || v.deprecated || v.lzReadCompatible) continue;
    if (!dvns[v.id]) dvns[v.id] = addr;
  }
  return { key: entry.chainKey, eid: Number(d.eid), endpoint: d.endpointV2.address, send: d.sendUln302.address, receive: d.receiveUln302.address, executor: d.executor.address, dvns };
}

const chains = ids.map(chainOf);
const providers = PREFERRED.filter((p) => chains.every((c) => c.dvns[p])).slice(0, 2);
if (providers.length < 2) throw new Error(`fewer than two verifiers shared by every chain: ${providers.join(", ")}`);
const me = chains[0];
const dvns = providers.map((p) => me.dvns[p].toLowerCase()).sort();
console.log(`LZ_ENDPOINT=${me.endpoint}`);
console.log(`LOCAL_EID=${me.eid}`);
console.log(`SEND_LIB=${me.send}`);
console.log(`RECEIVE_LIB=${me.receive}`);
console.log(`EXECUTOR=${me.executor}`);
console.log(`DVNS=${dvns.join(",")}`);
console.log(`DVN_PROVIDERS=${providers.join(",")}`);
