"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { NO_ANSWER, SENT_UNCONFIRMED, useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar } from "@/components/coins";
import { AiCoinPanel } from "@/components/aicoin";
import { EMPTY_DRAFT, LinkFields, draftProblems, draftToLinks, type LinkDraft } from "@/components/coinlinks";
import { toast } from "@/components/alerts";
import { saveLinks } from "@/lib/coinlinks";
import { call } from "@/lib/tx";
import { fileToLogo } from "@/lib/image";
import { friendlyError } from "@/lib/format";
import { isImageUrl } from "@/lib/data";
import { IS_TESTNET } from "@/lib/config";
import { RACE_CHAINS, chainsLinked, fetchRaceLinks, raceClient, raceErc20Abi, raceExplorerTx, raceFactoryAbi, raceHref, withGas, type RaceChain } from "@/lib/race";
import { GAS_ASK_CENTS, crossReady, homeChain } from "@/lib/racecross";
import { liveOn, planLaunch, sendLaunch, type LaunchPlan } from "@/lib/racecrossflow";

/**
 * sasa v7: launch a coin into the five-minute race. The coin is opened on each picked chain in
 * its own transaction (same launch key everywhere, so the same address and coin id). If the
 * user stops half-way, the page picks up with the chains that are still missing.
 */

const SAVE = "sasa-race-launch";
type Draft = {
  key: Hex;
  creator: string;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  feeMode: 0 | 1;
  chains: number[];
  firstBuy: string;
  /** X / Telegram / website, saved once the coin is live (optional). */
  socials?: LinkDraft;
  /** Email accounts: chains sent through Across, and until when each may still land (unix s). */
  sent?: Record<number, number>;
};
/** Rough Across fee per chain, for the total shown before launching (the real one is asked at launch). */
const ACROSS_FEE_GUESS = 0.15;
type ChainStatus = { state: "idle" | "working" | "done" | "error"; note?: string; tx?: string };
type Funds = { usd: bigint; usdDec: number; gas: bigint; min: bigint; open: boolean; fee: bigint };

const loadDraft = (): Draft | null => {
  try {
    return JSON.parse(localStorage.getItem(SAVE) ?? "null") as Draft | null;
  } catch {
    return null;
  }
};
const saveDraft = (d: Draft | null) => {
  try {
    if (d) localStorage.setItem(SAVE, JSON.stringify(d));
    else localStorage.removeItem(SAVE);
  } catch {}
};
/** A prepared launch is used for this long; it's prepared again a little before. */
const PREP_FRESH_MS = 90_000;
const PREP_RENEW_MS = 20_000;
const newKey = (): Hex => keccak256(toHex(`${Date.now()}-${Math.random()}-${Math.random()}`));
/** "Robinhood and Arc can't race together yet." for the first pair that isn't linked. */
function unlinkedText(ids: number[], links: Map<number, Set<number> | null>): string {
  for (const a of ids)
    for (const b of ids) {
      if (a === b) continue;
      const s = links.get(a);
      if (!s || !s.has(b)) {
        const A = RACE_CHAINS.find((c) => c.chainId === a)!;
        const B = RACE_CHAINS.find((c) => c.chainId === b)!;
        return s === null ? `Couldn't reach ${A.short}. Try again in a moment.` : `${A.short} and ${B.short} can't race together yet. Untick one of them.`;
      }
    }
  return "";
}
/** Total first buy we suggest; smaller is allowed (down to the contracts' minimum) with a note. */
const RECOMMENDED_BUY = 5;
/** The total split evenly over `n` chains, rounded down to the cent: what each chain's first buy is. */
const perChainOf = (total: string, n: number): string => {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0 || n <= 0) return "0";
  return (Math.floor((t * 100) / n + 1e-9) / 100).toFixed(2);
};
const cleanSym = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

export default function RaceLaunchPage() {
  const w = useWallet();
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  const [socials, setSocials] = useState<LinkDraft>(EMPTY_DRAFT);
  const [socialsOpen, setSocialsOpen] = useState(false);
  const [feeMode, setFeeMode] = useState<0 | 1>(0);
  const [chains, setChains] = useState<number[]>(RACE_CHAINS.map((c) => c.chainId));
  const [firstBuy, setFirstBuy] = useState("10");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Record<number, ChainStatus>>({});
  const [funds, setFunds] = useState<Record<number, Funds | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<Map<number, Set<number> | null> | null>(null);

  // Which chains can race together (every chain starts picked; a pair that can't is explained)
  useEffect(() => {
    let alive = true;
    fetchRaceLinks().then((l) => {
      if (alive) setLinks(l);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A launch left half-way by this wallet: offer to finish it.
  useEffect(() => {
    const d = loadDraft();
    if (d && w.address && d.creator.toLowerCase() === w.address.toLowerCase()) setDraft(d);
    else setDraft(null);
  }, [w.address]);

  const picked = useMemo(() => RACE_CHAINS.filter((c) => chains.includes(c.chainId)), [chains]);
  // email accounts on mainnet launch everything from their dollars on Base
  const home = homeChain();
  const viaBase = w.embedded && !IS_TESTNET && !!home;

  // What the wallet has on each picked chain, and each factory's minimum first buy.
  const readFunds = useCallback(async () => {
    const out: Record<number, Funds | null> = {};
    await Promise.all(
      RACE_CHAINS.map(async (c) => {
        try {
          const pub = raceClient(c);
          const [usdDec, min, open, usd, gas] = await Promise.all([
            pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }),
            pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "minFirstBuy" }),
            pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "launchesOpen" }),
            w.address ? pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [w.address] }) : Promise.resolve(0n),
            w.address ? pub.getBalance({ address: w.address }) : Promise.resolve(0n),
          ]);
          // the race fee (factories deployed before it existed have none)
          const fee = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "raceFee" }).catch(() => 0n)) as bigint;
          out[c.chainId] = { usdDec: Number(usdDec), min: min as bigint, open: open as boolean, usd: usd as bigint, gas, fee };
        } catch {
          out[c.chainId] = null;
        }
      })
    );
    setFunds(out);
  }, [w.address]);
  useEffect(() => {
    void readFunds();
  }, [readFunds]);

  const minUsd = useMemo(() => {
    const mins = picked.map((c) => funds[c.chainId]).filter((f): f is Funds => !!f).map((f) => Number(formatUnits(f.min, f.usdDec)));
    return mins.length ? Math.max(...mins) : 5;
  }, [picked, funds]);

  // race fee on the picked chains, in dollars (each chain's own setting)
  const raceFeeUsd = useMemo(
    () => picked.reduce((s, c) => {
      const f = funds[c.chainId];
      return s + (f ? Number(formatUnits(f.fee, f.usdDec)) : 0);
    }, 0),
    [picked, funds]
  );
  const sym = cleanSym(symbol);
  // `firstBuy` is the total; each chain gets an even share of it
  const buyN = Number(firstBuy);
  const perChain = perChainOf(firstBuy, picked.length);
  const perChainN = Number(perChain);
  const problem = !name.trim()
    ? "Give your coin a name."
    : sym.length < 2
      ? "The ticker needs at least 2 letters or numbers."
      : logo !== "" && !isImageUrl(logo)
        ? "That picture could not be used."
        : Object.values(draftProblems(socials)).some(Boolean)
          ? "One of the links doesn't look right. Fix it or leave it empty."
        : picked.length < 1
          ? "Pick at least one chain."
          : links && !chainsLinked(chains, links)
            ? unlinkedText(chains, links)
          : !Number.isFinite(buyN) || perChainN < minUsd
            ? `With ${picked.length} chains your first buy is at least $${(minUsd * picked.length).toLocaleString("en-US", { maximumFractionDigits: 2 })} ($${minUsd} on each chain).`
            : "";

  // Email accounts: about what the whole launch takes from the Base balance
  const crossCount = picked.filter((c) => home && c.chainId !== home.chainId).length;
  const viaBaseTotal = (Number.isFinite(buyN) ? Number(perChain) * picked.length : 0) + raceFeeUsd + crossCount * (ACROSS_FEE_GUESS + GAS_ASK_CENTS / 100);
  const homeFunds = home ? funds[home.chainId] : undefined;
  const viaBaseShort = (): string | null => {
    if (!viaBase || !homeFunds) return null;
    const closed = picked.find((c) => home && c.chainId !== home.chainId && !crossReady(c));
    if (closed) return `${closed.short} isn't open to email accounts yet. Untick it.`;
    const have = Number(formatUnits(homeFunds.usd, homeFunds.usdDec));
    if (have < viaBaseTotal + 0.05) return `Needs about $${(viaBaseTotal + 0.05).toFixed(2)} USDC on Base, you have $${have.toFixed(2)}. Add money with the + button.`;
    return null;
  };

  // Per chain: is something missing before the launch can go through?
  const shortOf = (c: RaceChain): string | null => {
    const f = funds[c.chainId];
    if (!w.address || f === undefined) return null;
    if (f === null) return "Couldn't reach this chain. Try again in a moment.";
    if (!f.open) return "Launches are paused on this chain.";
    if (f.gas === 0n) return `No ${c.chain.nativeCurrency.symbol} for the network fee.`;
    const need = (() => {
      try {
        return parseUnits(perChain, f.usdDec) + f.fee;
      } catch {
        return 0n;
      }
    })();
    if (f.usd < need) return `Needs $${Number(formatUnits(need, f.usdDec)).toFixed(2)} ${IS_TESTNET ? "test " : ""}USDC, you have $${Number(formatUnits(f.usd, f.usdDec)).toFixed(2)}.`;
    return null;
  };

  const faucet = async (c: RaceChain) => {
    if (!w.address) return;
    setStatus((s) => ({ ...s, [c.chainId]: { state: "working", note: "Getting test USDC…" } }));
    try {
      await w.send(c.chain, [call(c.usd, raceErc20Abi, "faucet", [w.address])]);
      setStatus((s) => ({ ...s, [c.chainId]: { state: "idle" } }));
    } catch (e) {
      const t = JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      setStatus((s) => ({ ...s, [c.chainId]: { state: "error", note: /TooSoon/.test(t) ? "Test USDC already taken today." : friendlyError(e) } }));
    }
    void readFunds();
  };

  /**
   * Email accounts (mainnet): one Base transaction launches on Base and sends the launch for
   * every other chain through Across (signed by the user); then each chain is watched until the
   * coin is live there. Anything Across can't deliver goes back to the user's balance on Base.
   */
  const runViaBase = async (d: Draft, ready?: LaunchPlan) => {
    const home = homeChain();
    if (!w.address || !home || !w.embeddedSigner || busy) return;
    setBusy(true);
    setError("");
    saveDraft(d);
    setDraft(d);
    const me = w.address as Address;
    const order = RACE_CHAINS.filter((c) => d.chains.includes(c.chainId));
    const set = (id: number, st: ChainStatus) => setStatus((s) => ({ ...s, [id]: st }));
    try {
      const live = new Set<number>();
      // a plan prepared while the form was filled in is for a brand-new key: nothing is live yet
      if (!ready) {
        await Promise.all(
          order.map(async (c) => {
            set(c.chainId, { state: "working", note: "Checking…" });
            if (await liveOn(c, me, d.key)) {
              live.add(c.chainId);
              set(c.chainId, { state: "done", note: "Live" });
            }
          })
        );
      }
      const plan = ready ?? await planLaunch({
        user: me,
        signer: w.embeddedSigner,
        home,
        picked: order,
        d: { ...d },
        live,
        onStep: (m) => order.forEach((c) => !live.has(c.chainId) && set(c.chainId, { state: "working", note: m })),
      });
      let tx: string | undefined;
      // the Base bundle went out but its confirmation didn't come back: watch the chains instead
      let unconfirmed = false;
      if (plan.calls.length) {
        // remembered BEFORE sending: if the send is unconfirmed or the tab closes, Continue
        // waits for these deliveries instead of paying for them a second time
        const before = d;
        const next = { ...d, sent: { ...(d.sent ?? {}), ...plan.crossUntil } };
        saveDraft(next);
        setDraft(next);
        d = next;
        try {
          tx = await sendLaunch({ s: { user: me, sendHome: w.send, sendThere: w.sendOwnGas }, home, plan, onStep: (m) => order.forEach((c) => !live.has(c.chainId) && set(c.chainId, { state: "working", note: m })) });
        } catch (e) {
          const m = String((e as Error)?.message ?? "");
          // surely not sent: forget it, so Continue can send it again
          if (m !== SENT_UNCONFIRMED && m !== NO_ANSWER) {
            saveDraft(before);
            setDraft(before);
            throw e;
          }
          if (m === NO_ANSWER) throw e;
          unconfirmed = true;
        }
      }
      const homeWatch = plan.homeLaunch && unconfirmed;
      if (plan.homeLaunch && !unconfirmed) set(home.chainId, { state: "done", note: "Live", tx });
      // watch every chain until the coin is live there, or its delivery window has passed
      const homeUntil = Math.floor(Date.now() / 1000) + 5 * 60;
      const waiting = new Set(order.filter((c) => !live.has(c.chainId) && (c.chainId !== home.chainId || homeWatch)).map((c) => c.chainId));
      waiting.forEach((id) => set(id, { state: "working", note: "On its way…" }));
      while (waiting.size) {
        await new Promise((r) => setTimeout(r, 1_500));
        for (const id of [...waiting]) {
          const c = order.find((x) => x.chainId === id)!;
          if (await liveOn(c, me, d.key).catch(() => false)) {
            waiting.delete(id);
            set(id, { state: "done", note: "Live" });
          } else if (id === home.chainId) {
            if (Math.floor(Date.now() / 1000) > homeUntil) {
              waiting.delete(id);
              set(id, { state: "error", note: "Not confirmed yet. Check your balance, then press Continue (nothing is paid twice)." });
            }
          } else if (Math.floor(Date.now() / 1000) > (d.sent?.[id] ?? 0) + 60) {
            waiting.delete(id);
            set(id, { state: "error", note: "Didn't arrive in time. Across returns the dollars for this chain to your balance on Base (this can take a few hours)." });
          }
        }
      }
      setBusy(false);
      const coinId = (await raceClient(home).readContract({ address: home.factory, abi: raceFactoryAbi, functionName: "coinIdOf", args: [me, d.key] })) as Hex;
      const allLive = (await Promise.all(order.map((c) => liveOn(c, me, d.key).catch(() => false)))).every(Boolean);
      if (allLive) {
        saveDraft(null);
        await saveSocials(d, coinId);
        router.push(raceHref(coinId.toLowerCase()));
      } else {
        setError("Not live everywhere yet. Press Continue to try the missing chains again (live chains are skipped).");
      }
    } catch (e) {
      setBusy(false);
      setError(friendlyError(e));
      order.forEach((c) => setStatus((s) => (s[c.chainId]?.state === "working" ? { ...s, [c.chainId]: { state: "error", note: friendlyError(e) } } : s)));
    }
  };

  /** The coin's X / Telegram / website, once it is live. The launch key proves who made it, so
   * this works at once (before the coin is listed). Never stops the launch: if it fails, the
   * creator adds them from the coin's page. */
  const saveSocials = async (d: Draft, coinId: Hex) => {
    const l = d.socials ? draftToLinks(d.socials) : null;
    if (!l || (!l.x && !l.telegram && !l.website)) return;
    try {
      await saveLinks(w.signMessage, coinId, l, { launchKey: d.key });
    } catch {
      toast("Your coin is live. The links didn't save: add them on the coin's page.");
    }
  };

  /** Opens the coin on every chain of `d` that doesn't have it yet, one after the other. */
  const run = async (d: Draft) => {
    if (viaBase) return runViaBase(d);
    if (!w.address || busy) return;
    setBusy(true);
    setError("");
    saveDraft(d);
    setDraft(d);
    const me = w.address as Address;
    const order = RACE_CHAINS.filter((c) => d.chains.includes(c.chainId));
    const eids = order.map((c) => c.eid).sort((a, b) => a - b);
    let failed = false;
    let coinId: Hex | null = null;
    for (const c of order) {
      const pub = raceClient(c);
      const set = (st: ChainStatus) => setStatus((s) => ({ ...s, [c.chainId]: st }));
      try {
        set({ state: "working", note: "Checking…" });
        const coin = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "coinAddress", args: [me, d.key] })) as Address;
        coinId = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "coinIdOf", args: [me, d.key] })) as Hex;
        const code = await pub.getCode({ address: coin });
        if (code && code.length > 2) {
          set({ state: "done", note: "Live" });
          continue;
        }
        const dec = Number(await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }));
        const amount = parseUnits(d.firstBuy, dec);
        // the factory takes the first buy and this chain's race fee
        const fee = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "raceFee" }).catch(() => 0n)) as bigint;
        const spend = amount + fee;
        const allowance = (await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "allowance", args: [me, c.factory] })) as bigint;
        if (allowance < spend) {
          await w.send(c.chain, [call(c.usd, raceErc20Abi, "approve", [c.factory, spend])], (m) => set({ state: "working", note: `Approve: ${m}` }));
          // the node answering next may be a block behind the approval: wait until it sees it
          for (let i = 0; i < 8; i++) {
            const a = (await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "allowance", args: [me, c.factory] }).catch(() => 0n)) as bigint;
            if (a >= spend) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        const launchCall = await withGas(
          pub,
          me,
          call(c.factory, raceFactoryAbi as never, "launch", [
            {
              name: d.name,
              symbol: d.symbol,
              logo: d.logo,
              description: d.description,
              launchKey: d.key,
              eids,
              feeMode: d.feeMode,
              firstBuy: amount,
              // the pool opens inside this same transaction: nobody can trade before the first buy
              minCoinsOut: 0n,
            },
          ])
        );
        const tx = await w.send(c.chain, [launchCall], (m) => set({ state: "working", note: m }));
        set({ state: "done", note: "Live", tx });
      } catch (e) {
        failed = true;
        set({ state: "error", note: friendlyError(e) });
        break;
      }
    }
    setBusy(false);
    void readFunds();
    if (!failed && coinId) {
      saveDraft(null);
      await saveSocials(d, coinId);
      router.push(raceHref(coinId.toLowerCase()));
    } else {
      setError("Stopped. Fix what's shown and press Continue: chains that are already live are skipped.");
    }
  };

  // Email accounts: the launch is prepared in the background once the form is complete (prices
  // from Across, the signatures), so pressing Create sends it right away. Prepared again when
  // the form changes or the prices get old. It uses its own new key and is sent only on Create.
  const prep = useRef<{ sig: string; key: Hex; plan: LaunchPlan; at: number } | null>(null);
  const prepKey = useRef<Hex>(newKey());
  const [prepTick, setPrepTick] = useState(0);
  const prepSig = JSON.stringify([w.address, name.trim(), sym, logo, description.trim(), feeMode, chains, perChain]);
  const prepOk = viaBase && !problem && !viaBaseShort() && !busy && !draft && !!w.address && !!w.embeddedSigner;
  useEffect(() => {
    if (!prepOk || !home || !w.address || !w.embeddedSigner) return;
    // time left before the prepared launch should be prepared again (0: prepare now)
    const cur = prep.current;
    const left = cur && cur.sig === prepSig ? Math.max(0, cur.at + PREP_FRESH_MS - PREP_RENEW_MS - Date.now()) : 0;
    let alive = true;
    const user = w.address as Address;
    const signer = w.embeddedSigner;
    const prepare = async () => {
      const key = prepKey.current;
      const order = RACE_CHAINS.filter((c) => chains.includes(c.chainId));
      try {
        const plan = await planLaunch({
          user,
          signer,
          home,
          picked: order,
          d: { key, name: name.trim(), symbol: sym, logo, description: description.trim(), feeMode, chains, firstBuy: perChain },
          live: new Set(),
        });
        if (alive && key === prepKey.current) prep.current = { sig: prepSig, key, plan, at: Date.now() };
      } catch {
        // not ready (a price, a chain): Create prepares it again itself
      }
    };
    const t = left === 0 ? setTimeout(() => void prepare(), 1_200) : null;
    // prices get old: look again a little before they do
    const renew = setTimeout(() => alive && setPrepTick((n) => n + 1), left > 0 ? left + 500 : PREP_FRESH_MS - PREP_RENEW_MS + 5_000);
    return () => {
      alive = false;
      if (t) clearTimeout(t);
      clearTimeout(renew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepOk, prepSig, prepTick]);

  const start = () => {
    if (problem || !w.address) return;
    // the draft keeps each chain's share, so a resumed launch buys the same on the chains left
    const p = prep.current;
    prep.current = null;
    if (viaBase && p && p.sig === prepSig && Date.now() - p.at < PREP_FRESH_MS) {
      // prepared while the form was filled in: goes out at once
      prepKey.current = newKey();
      void runViaBase({ key: p.key, creator: w.address, name: name.trim(), symbol: sym, logo, description: description.trim(), feeMode, chains, firstBuy: perChain, socials }, p.plan);
      return;
    }
    prepKey.current = newKey();
    void run({ key: newKey(), creator: w.address, name: name.trim(), symbol: sym, logo, description: description.trim(), feeMode, chains, firstBuy: perChain, socials });
  };

  const toggle = (id: number) => setChains((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const input = "w-full h-12 rounded-xl border border-line bg-paper px-4 text-[1rem] outline-none focus:border-ink-3 min-w-0";

  if (!RACE_CHAINS.length) {
    return <div className="max-w-xl mx-auto px-4 py-16 text-center text-ink-2">Races open soon.</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-4 pb-24 lg:pb-12 flex flex-col gap-5 min-w-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-[1.75rem] sm:text-[2.25rem] font-extrabold tracking-tight">Create your coin on multiple chains</h1>
        <p className="text-ink-2 text-[0.9375rem]">Your coin goes live on every chain you pick. After 5 minutes, the chain with the most money wins and the whole coin moves there.</p>
      </div>

      {draft && !busy && (
        <div className="rounded-2xl border border-line bg-night p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <CoinAvatar logo={draft.logo} symbol={draft.symbol} size={40} />
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {draft.name} <span className="text-ink-3">{draft.symbol}</span>
              </div>
              <div className="text-[0.8125rem] text-ink-2">Not live on every chain yet.</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void run(draft)} className="h-11 px-5 rounded-full bg-ink text-paper font-semibold">
              Continue
            </button>
            <button
              type="button"
              onClick={() => {
                saveDraft(null);
                setDraft(null);
                setStatus({});
              }}
              className="h-11 px-4 rounded-full border border-line text-ink-2"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px] gap-5 lg:gap-8 items-start">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-5 min-w-0">
          <div className="rounded-2xl border border-emerald/40 bg-emerald-soft p-3 sm:p-4 flex flex-col gap-3">
            <button type="button" onClick={() => setAiOpen((o) => !o)} aria-expanded={aiOpen} className="flex items-center justify-between gap-3 text-left">
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[1rem]" style={{ background: "linear-gradient(135deg, #ffb020, #ff6b1a)" }} aria-hidden="true">
                  ✨
                </span>
                <span className="font-bold text-[0.9375rem] text-emerald-dark">Create with AI</span>
              </span>
              <span className="text-[0.8125rem] text-ink-2 shrink-0">{aiOpen ? "Close" : "Pick a topic, get a coin →"}</span>
            </button>
            {aiOpen && (
              <AiCoinPanel
                onFill={(f) => {
                  setName(f.name);
                  setSymbol(f.symbol);
                  setDescription(f.description);
                  if (f.logo) {
                    setLogo(f.logo);
                    setPicError("");
                  } else {
                    // the old picture belonged to the previous idea
                    setLogo("");
                    setPicError(f.logoError ?? "");
                  }
                  setAiOpen(false);
                }}
              />
            )}
          </div>
          <div className="grid grid-cols-[88px_minmax(0,1fr)] sm:grid-cols-[120px_minmax(0,1fr)] gap-4 items-start">
            <label className="relative aspect-square rounded-2xl border-2 border-dashed border-line hover:border-ink-3 bg-paper flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <>
                  <span className="text-[1.5rem]" aria-hidden="true">
                    ＋
                  </span>
                  <span className="text-[0.8125rem] font-semibold">{picBusy ? "…" : "Picture"}</span>
                </>
              )}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={picBusy}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setPicError("");
                  setPicBusy(true);
                  try {
                    setLogo(await fileToLogo(f));
                  } catch (err) {
                    setPicError((err as Error).message);
                  } finally {
                    setPicBusy(false);
                  }
                }}
              />
            </label>
            <div className="flex flex-col gap-3 min-w-0">
              <label className="flex flex-col gap-1">
                <span className="text-[0.8125rem] text-ink-3">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Harbor Cat" className={input} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.8125rem] text-ink-3 flex justify-between">
                  Ticker <span>{sym.length}/10</span>
                </span>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={12} placeholder="HCAT" autoCapitalize="characters" className={input + " uppercase"} />
              </label>
            </div>
          </div>
          {logo && (
            <button type="button" onClick={() => setLogo("")} className="self-start text-[0.8125rem] text-ink-3 underline">
              Remove picture
            </button>
          )}
          {picError && <p className="text-[0.8125rem] text-danger">{picError}</p>}

          <label className="flex flex-col gap-1">
            <span className="text-[0.8125rem] text-ink-3">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
              rows={2}
              placeholder="What's the story?"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-[1rem] outline-none focus:border-ink-3 resize-none min-w-0"
            />
          </label>

          {/* X / Telegram / website: optional, saved as soon as the coin is live */}
          {socialsOpen || socials.x || socials.telegram || socials.website ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] text-ink-3">Links (optional)</span>
              <LinkFields value={socials} onChange={setSocials} />
            </div>
          ) : (
            <button type="button" onClick={() => setSocialsOpen(true)} className="self-start text-[0.875rem] font-semibold text-emerald">
              + Add links (X, Telegram, website)
            </button>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-[0.8125rem] text-ink-3">Pick your chains (multi-chain recommended)</span>
            <div className="grid grid-cols-2 gap-2">
              {RACE_CHAINS.map((c) => {
                const on = chains.includes(c.chainId);
                return (
                  <button
                    key={c.chainId}
                    type="button"
                    onClick={() => toggle(c.chainId)}
                    className={"h-11 rounded-xl border px-3 flex items-center gap-2 text-[0.9375rem] min-w-0 " + (on ? "border-ink font-semibold" : "border-line text-ink-3")}
                    aria-pressed={on}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: on ? c.color : "var(--color-line)" }} />
                    <span className="truncate">{c.short}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[0.8125rem] text-ink-3">Trading fees</span>
            <div className="grid grid-cols-2 gap-2">
              {[
                { v: 0 as const, t: "To me", d: "Your share of the fees goes to your wallet" },
                { v: 1 as const, t: "Buyback & burn", d: "Your share buys the coin back and burns it" },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setFeeMode(o.v)}
                  className={"rounded-xl border p-3 text-left " + (feeMode === o.v ? "border-ink" : "border-line")}
                  aria-pressed={feeMode === o.v}
                >
                  <div className="font-semibold text-[0.9375rem]">{o.t}</div>
                  <div className="hidden sm:block text-[0.8125rem] text-ink-3">{o.d}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-ink-3">Your first buy, in total (USDC)</span>
            <div className="grid grid-cols-3 gap-2">
              {["10", "50", "100"].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setFirstBuy(v)}
                  aria-pressed={firstBuy === v}
                  className={"h-11 rounded-xl border font-semibold text-[0.9375rem] " + (firstBuy === v ? "border-ink ring-1 ring-ink" : "border-line text-ink-2")}
                >
                  ${v}
                </button>
              ))}
            </div>
            <label className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
              <input
                inputMode="decimal"
                value={firstBuy}
                onChange={(e) => setFirstBuy(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                placeholder="Or type any amount"
                aria-label="Your first buy in total, in dollars"
                className={input + " pl-8"}
              />
            </label>
            {Number.isFinite(buyN) && buyN > 0 && buyN < RECOMMENDED_BUY && perChainN >= minUsd && (
              <span className="text-[0.8125rem] text-warn-ink">We recommend ${RECOMMENDED_BUY} or more, so your coin starts with some weight.</span>
            )}
            <span className="text-[0.8125rem] text-ink-3">
              {picked.length > 0 && perChainN > 0
                ? picked.length === 1
                  ? `$${perChain} on ${picked[0].short}. Your first buy pays the 2% floor fee.`
                  : `$${perChain} on each of your ${picked.length} chains. Your first buy pays the 2% floor fee.`
                : "Split evenly over the chains you pick. Your first buy pays the 2% floor fee."}
            </span>
            {raceFeeUsd > 0 && (
              <span className="text-[0.8125rem] text-ink-3">
                Race fee: ${raceFeeUsd.toFixed(2)} (covers the network fees of running your race). Total: $
                {((Number.isFinite(buyN) ? Number(perChain) * picked.length : 0) + raceFeeUsd).toFixed(2)}
              </span>
            )}
          </div>
        </div>

        <aside className="rounded-3xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-4 min-w-0 lg:sticky lg:top-20">
          {!w.address ? (
            <ConnectButton />
          ) : w.embedded && !viaBase ? (
            IS_TESTNET ? <p className="text-[0.8125rem] text-ink-3">Testnet: create with a browser wallet.</p> : null
          ) : viaBase ? (
            <ul className="flex flex-col gap-3">
              {picked.map((c) => {
                const st = status[c.chainId];
                return (
                  <li key={c.chainId} className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                      <span className="font-semibold text-[0.9375rem] truncate flex-1">{c.name}</span>
                      <span className={"text-[0.8125rem] shrink-0 " + (st?.state === "done" ? "text-up font-semibold" : st?.state === "error" ? "text-danger" : "text-ink-3")}>
                        {st?.state === "done" ? "✓ Live" : st?.state === "working" ? "…" : st?.state === "error" ? "Failed" : "Ready"}
                      </span>
                    </div>
                    {st?.note && st.state !== "done" && <p className="text-[0.8125rem] text-ink-2 break-words pl-[1.125rem]">{st.note}</p>}
                    {st?.tx && (
                      <a href={raceExplorerTx(home!, st.tx)} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-ink-3 underline pl-[1.125rem]">
                        View transaction
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="flex flex-col gap-3">
              {picked.map((c) => {
                const st = status[c.chainId];
                const short = st?.state === "done" ? null : shortOf(c);
                return (
                  <li key={c.chainId} className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                      <span className="font-semibold text-[0.9375rem] truncate flex-1">{c.name}</span>
                      <span
                        className={
                          "text-[0.8125rem] shrink-0 " +
                          (st?.state === "done" ? "text-up font-semibold" : st?.state === "error" ? "text-danger" : short ? "text-warn-ink" : "text-ink-3")
                        }
                      >
                        {st?.state === "done" ? "✓ Live" : st?.state === "working" ? "…" : st?.state === "error" ? "Failed" : short ? "Missing" : "Ready"}
                      </span>
                    </div>
                    {(st?.note && st.state !== "done") || short ? (
                      <p className="text-[0.8125rem] text-ink-2 break-words pl-[1.125rem]">{st?.note && st.state !== "done" ? st.note : short}</p>
                    ) : null}
                    {st?.tx && (
                      <a href={raceExplorerTx(c, st.tx)} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-ink-3 underline pl-[1.125rem]">
                        View transaction
                      </a>
                    )}
                    {short && st?.state !== "working" && (
                      <div className="flex gap-3 pl-[1.125rem] text-[0.8125rem]">
                        {c.faucet && /USDC/.test(short) && (
                          <button type="button" onClick={() => void faucet(c)} className="text-emerald-dark font-semibold underline">
                            Get $100 test USDC
                          </button>
                        )}
                        {c.gasFaucet && /network fee/.test(short) && (
                          <a href={c.gasFaucet} target="_blank" rel="noreferrer" className="text-emerald-dark font-semibold underline">
                            Get {c.chain.nativeCurrency.symbol}
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {viaBase && (
            <>
              <button
                type="button"
                onClick={start}
                disabled={busy || !!problem || !!viaBaseShort()}
                className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
              >
                {busy ? "Creating…" : `Create on ${picked.length} chain${picked.length === 1 ? "" : "s"}`}
              </button>
              {(problem || viaBaseShort()) && <p className="text-[0.8125rem] text-ink-2 text-center">{problem || viaBaseShort()}</p>}
              {error && <p className="text-[0.8125rem] text-danger text-center">{error}</p>}
              <p className="text-[0.75rem] text-ink-3 text-center">
                About ${viaBaseTotal.toFixed(2)} from your balance on Base, in one step: first buys, race fees
                {crossCount > 0 ? ", Across fees and a little gas on the other chains" : ""}. Other chains go live about a minute after Base.
              </p>
            </>
          )}

          {w.address && !w.embedded && (
            <>
              <button
                type="button"
                onClick={start}
                disabled={busy || !!problem || picked.some((c) => !!shortOf(c))}
                className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
              >
                {busy ? "Creating…" : `Create on ${picked.length} chain${picked.length === 1 ? "" : "s"}`}
              </button>
              {problem && <p className="text-[0.8125rem] text-ink-2 text-center">{problem}</p>}
              {error && <p className="text-[0.8125rem] text-danger text-center">{error}</p>}
              <p className="text-[0.75rem] text-ink-3 text-center">
                Your wallet asks once or twice per chain (approve, launch). Each chain&apos;s five minutes start when it goes live.
              </p>
            </>
          )}
          <Link href="/race/" className="text-[0.8125rem] text-ink-3 underline self-center">
            How the race works
          </Link>
        </aside>
      </div>
    </div>
  );
}
