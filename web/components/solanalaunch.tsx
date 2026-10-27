"use client";

/**
 * The Create page's Solana side (only for people who see Solana: lib/solana.ts solanaFor).
 * One button: the dollars for the first buy and the launch move from the user's Cash to their
 * Solana wallet (Relay), then the coin is made on Solana (lib/sollaunch.ts). The user sees
 * dollars and their coin, nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useWallet } from "./wallet";
import { SolanaMark } from "./solanamoney";
import { SolCashBack } from "./soltrade";
import { CoinAvatar } from "./coins";
import { Confetti } from "./confetti";
import { justLaunched } from "@/lib/extcoins";
import { solInflight } from "@/lib/solheld";
import { postOnX } from "./share";
import { toast } from "./alerts";
import { draftToLinks, type LinkDraft } from "./coinlinks";
import { usdcAbi } from "@/lib/abis";
import { CHAINS } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { quoteCalls } from "@/lib/extswap";
import { friendlyError } from "@/lib/format";
import { fileToBigLogo } from "@/lib/image";
import { afterTrade } from "@/lib/portfolio";
import { getQuote, requestStatus } from "@/lib/relay";
import { SOLANA_ID, SOL_NATIVE, dexscreenerSol, gmgnSol, solscanToken } from "@/lib/solana";
import type { SolSigner } from "@/lib/sollaunch";
import { geoExempt } from "@/lib/perps";

const BASE = CHAINS.find((c) => c.key === "base")!;
const PENDING = "sasa-sol-pending";
type Pending = { mint: string; creator: string; name: string; symbol: string; logo: string };
type Done = { mint: string; name: string; symbol: string; logo: string; finished: boolean; bought: boolean };

const loadPending = (): Pending | null => {
  try {
    return JSON.parse(localStorage.getItem(PENDING) ?? "null") as Pending | null;
  } catch {
    return null;
  }
};
const savePending = (p: Pending | null) => {
  try {
    if (p) localStorage.setItem(PENDING, JSON.stringify(p));
    else localStorage.removeItem(PENDING);
  } catch {}
};
/** The sasa sign-in token, if this wallet has one already (the coin is linked to the account). */
const sessionToken = (address: string): string | null => {
  try {
    const s = JSON.parse(localStorage.getItem(`sasa-session:${address.toLowerCase()}`) ?? "null") as { token?: string; exp?: number } | null;
    return s?.token && (s.exp ?? 0) * 1000 > Date.now() + 60_000 ? s.token : null;
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SolanaLaunchBox(p: {
  name: string;
  symbol: string;
  description: string;
  logo: string;
  logoFile: File | null;
  socials: LinkDraft;
  firstBuy: string;
  problem: string;
}) {
  const w = useWallet();
  const [ext, setExt] = useState<{ name: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  // the step a launch was on when it failed (sent with the error report)
  const stepRef = useRef("");
  useEffect(() => {
    if (step) stepRef.current = step;
  }, [step]);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  // the launch party: confetti once, when the coin is live
  const [party, setParty] = useState(true);
  const endParty = useCallback(() => setParty(false), []);
  const [pending, setPending] = useState<Pending | null>(null);
  // admin test only (sasa's own wallets): launch with sasa's own fee settings (lib/soldbc.ts)
  const admin = geoExempt(w.address);
  const [ownFee, setOwnFee] = useState(false);
  const alive = useRef(true);
  // one launch at a time: locked before anything is awaited (a double tap can't launch twice)
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => setPending(loadPending()), []);

  const usdBuy = Number(p.firstBuy);
  const buyOk = p.firstBuy.trim() === "" || (Number.isFinite(usdBuy) && usdBuy >= 0 && usdBuy <= 10_000);
  // Solana keeps at most 32 bytes of name (an emoji takes 4)
  const nameBytes = new TextEncoder().encode(p.name).length;
  const problem =
    p.problem ||
    (nameBytes > 32
      ? "That name is too long for Solana. Make it shorter (emoji count as several letters)."
      : !p.logo
        ? "Add a picture: Solana apps show it everywhere."
        : !buyOk
          ? "Check the first buy amount."
          : "");

  /** Who signs on Solana: the email account's Solana wallet, or Phantom & co. */
  const signer = async (): Promise<SolSigner> => {
    if (w.embedded) {
      if (!w.solana) throw new Error("Your account is still loading. Try again in a moment.");
      const address = await w.solana.create();
      return { address, sign: w.solana.sign };
    }
    const { connectSolanaWallet, signWithSolanaWallet } = await import("@/lib/solwallet");
    const c = ext ?? (await connectSolanaWallet());
    setExt(c);
    return { address: c.address, sign: signWithSolanaWallet };
  };

  /** Moves dollars from Cash (USDC on Base) to SOL in the Solana wallet until it holds `need`. */
  const fund = async (to: string, need: bigint, balance: () => Promise<bigint>) => {
    const have = await balance();
    if (have >= need) return;
    if (!w.address) throw new Error("Log in first.");
    // a little extra, so prices moving on the way don't leave it short
    const missing = need - have + 2_000_000n;
    setStep("Getting the best route…");
    // Relay refuses a route bigger than the Cash with a vague "Could not process request":
    // when that happens and the Cash is short, say so plainly instead
    const cashNow = () => clientFor(BASE).readContract({ address: BASE.usdc, abi: usdcAbi, functionName: "balanceOf", args: [w.address as Address] }) as Promise<bigint>;
    const q = await getQuote({
      user: w.address,
      recipient: to,
      originChainId: BASE.chain.id,
      originCurrency: BASE.usdc,
      destinationChainId: SOLANA_ID,
      destinationCurrency: SOL_NATIVE,
      amount: missing.toString(),
      tradeType: "EXACT_OUTPUT",
      fee: "deposit",
    }).catch(async (e) => {
      const cash = await cashNow().catch(() => null);
      const need = (usdBuy > 0 ? usdBuy : 0) + 5;
      if (cash !== null && Number(cash) / 1e6 < need)
        throw new Error(`Not enough Cash: this launch needs about $${need.toFixed(0)} and you have $${(Number(cash) / 1e6).toFixed(2)}. Add money or lower the first buy.`);
      throw e;
    });
    const cash = await cashNow();
    // email accounts pay Base's network fee from the same dollars: a few cents of room
    if (cash < BigInt(q.inRaw || "0") + (w.embedded ? 50_000n : 0n))
      throw new Error(`This needs about $${(q.inUsd + 0.05).toFixed(2)} in your Cash. Add money or lower the first buy.`);
    await w.send(BASE.chain, quoteCalls(q, BASE), (m) => setStep(m));
    afterTrade();
    setStep("Moving your dollars to Solana…");
    for (let i = 0; i < 170 && alive.current; i++) {
      if ((await balance().catch(() => 0n)) >= need) return;
      if (q.requestId && i % 5 === 4) {
        const s = await requestStatus(q.requestId).catch(() => "waiting" as const);
        if (s === "failure" || s === "refund") throw new Error("The move to Solana didn't go through. Your dollars went back to your Cash.");
      }
      await sleep(800);
    }
    throw new Error("The dollars are still on their way. Press Create again in a minute (nothing is paid twice).");
  };

  const start = async () => {
    if (lock.current || busy || problem || !w.address) return;
    lock.current = true;
    setBusy(true);
    setError("");
    // the coin about to go on chain: kept on this device before it's sent, so a closed tab or a
    // failure half-way still offers "Finish" (the 50/50 split) afterwards
    let sent: Pending | null = null;
    // SOL is coming into the Solana wallet for this launch: the "back to Cash" helper waits
    solInflight(true);
    try {
      setStep("Getting ready…");
      const L = await import("@/lib/sollaunch");
      const config = await L.solConfig();
      if (!config.treasury) throw new Error("Solana launches open soon.");
      const own = ownFee && admin;
      if (own && !config.dbc) throw new Error("Own-fee launches are still being set up by sasa's keeper. Try again in a few minutes.");
      const s = await signer();
      const balance = () => L.solBalance(s.address);

      // the picture upload and the first buy's price run side by side (a launch is a few seconds faster)
      setStep("Getting your coin ready…");
      const upload = (async () => {
        const image = p.logoFile ? await fileToBigLogo(p.logoFile).catch(() => p.logo) : p.logo;
        const l = draftToLinks(p.socials);
        return L.uploadCoinInfo({
          name: p.name,
          symbol: p.symbol,
          description: p.description,
          image,
          twitter: l.x ?? undefined,
          telegram: l.telegram ?? undefined,
          website: l.website ?? undefined,
        });
      })();
      // what the first buy's dollars are in SOL right now
      const planning = (async () => {
        let buyLamports = 0n;
        if (usdBuy > 0) {
          const probe = await getQuote({
            user: w.address!,
            recipient: s.address,
            originChainId: BASE.chain.id,
            originCurrency: BASE.usdc,
            destinationChainId: SOLANA_ID,
            destinationCurrency: SOL_NATIVE,
            amount: String(Math.floor(usdBuy * 1e6)),
          });
          buyLamports = BigInt(probe.outRaw || "0");
        }
        return { buyLamports, plan: own ? null : await L.planLaunch(buyLamports) };
      })();
      const [info, { buyLamports, plan }] = await Promise.all([upload, planning]);

      if (own) {
        // sasa's own fee settings: the coin, its pool and the first buy in one transaction
        const [D, { Keypair }] = await Promise.all([import("@/lib/soldbc"), import("@solana/web3.js")]);
        const mint = Keypair.generate();
        await Promise.all([
          fund(s.address, buyLamports + D.DBC_RESERVE_LAMPORTS, balance),
          L.recordCoin(
            { mint: mint.publicKey.toBase58(), creator: s.address, uri: info.uri, sig: "", name: p.name, symbol: p.symbol, image: info.image, kind: "dbc" },
            sessionToken(w.address)
          ),
        ]);
        const res = await D.dbcLaunch({ signer: s, mint, name: p.name, symbol: p.symbol, uri: info.uri, buyLamports, onStep: setStep });
        setDone({ mint: res.mint, name: p.name, symbol: p.symbol, logo: p.logo, finished: true, bought: true });
        justLaunched({ address: res.mint, name: p.name, symbol: p.symbol, image: info.image });
        toast("Your coin is live on Solana ✓");
        return;
      }
      if (!plan) throw new Error("Couldn't plan the launch. Try again.");

      // sasa hears about the coin before it's signed, so a closed tab can't leave it unknown
      // (the keeper lists it only once it's on chain with the 50/50 split); done while the
      // dollars move to Solana
      await Promise.all([
        fund(s.address, L.lamportsNeeded(plan), balance),
        L.recordCoin({ mint: plan.mint.publicKey.toBase58(), creator: s.address, uri: info.uri, sig: "", name: p.name, symbol: p.symbol, image: info.image }, sessionToken(w.address)),
      ]);
      sent = { mint: plan.mint.publicKey.toBase58(), name: p.name, symbol: p.symbol, logo: p.logo, creator: s.address };
      savePending(sent);
      const res = await L.sendLaunch({ plan, signer: s, config, name: p.name, symbol: p.symbol, uri: info.uri, onStep: setStep });
      const coin = { mint: res.mint, name: p.name, symbol: p.symbol, logo: p.logo };
      if (!res.finished) setPending({ ...coin, creator: s.address });
      else savePending(null);
      setDone({ ...coin, finished: res.finished, bought: res.bought || buyLamports === 0n });
      if (res.finished) justLaunched({ address: res.mint, name: p.name, symbol: p.symbol, image: info.image });
      toast("Your coin is live on Solana ✓");
    } catch (e) {
      setError(friendlyError(e));
      // the admins see every failed launch, with the step and Solana's own words (bot page)
      try {
        const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
        const logs = (err.logs ?? err.transactionLogs ?? []).slice(-6).join(" | ");
        void fetch("/api/sol/error", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step: stepRef.current, error: `${String(err?.message ?? e)}${logs ? ` || ${logs}` : ""}`.slice(0, 800), mint: sent?.mint, kind: ownFee && admin ? "dbc" : "pump" }),
        }).catch(() => {});
      } catch {
        /* never stands in the way */
      }
      // did the coin make it on chain before the failure? then "Finish" stays; if not, nothing to finish
      if (sent) {
        const mint = sent.mint;
        const exists = await Promise.all([import("@/lib/sollaunch"), import("@solana/web3.js")])
          .then(async ([L, { PublicKey }]) => !!(await L.solConnection().getAccountInfo(new PublicKey(mint), "confirmed")))
          .catch(() => true);
        if (exists) setPending(sent);
        else savePending(null);
      }
    } finally {
      solInflight(false);
      lock.current = false;
      setBusy(false);
      setStep("");
    }
  };

  const finish = async (pd: Pending) => {
    if (lock.current || busy) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const L = await import("@/lib/sollaunch");
      const config = await L.solConfig();
      const s = await signer();
      if (s.address !== pd.creator) throw new Error("Open the wallet you launched this coin with.");
      await L.finishLaunch({ mint: pd.mint, signer: s, config, onStep: setStep });
      savePending(null);
      setPending(null);
      setDone({ ...pd, finished: true, bought: true });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
      setStep("");
    }
  };

  if (done)
    return (
      <div className="flex flex-col gap-3 items-center text-center py-2">
        {party && <Confetti onDone={endParty} />}
        <CoinAvatar logo={done.logo} symbol={done.symbol} size={56} />
        <div>
          <div className="font-bold text-[1.0625rem]">
            {done.name} <span className="text-ink-3">{done.symbol}</span>
          </div>
          <div className="text-[0.875rem] text-up font-semibold mt-0.5">✓ Live on Solana</div>
        </div>
        {!done.finished && (
          <p className="text-[0.8125rem] text-warn-ink">One last step didn&apos;t go through. Press Finish below so your creator rewards start.</p>
        )}
        {done.finished && !done.bought && (
          <p className="text-[0.8125rem] text-warn-ink">Your first buy didn&apos;t go through (the price moved). The money for it is waiting in your Solana wallet.</p>
        )}
        <p className="text-[0.8125rem] text-ink-2">It&apos;s on DexScreener, GMGN and every Solana app now. Your creator rewards from every trade come to your wallet automatically.</p>
        <div className="grid grid-cols-3 gap-2 w-full">
          {[
            ["DexScreener", dexscreenerSol(done.mint)],
            ["GMGN", gmgnSol(done.mint)],
            ["Solscan", solscanToken(done.mint)],
          ].map(([t, href]) => (
            <a key={t} href={href} target="_blank" rel="noreferrer" className="h-10 rounded-xl border border-line grid place-items-center text-[0.8125rem] font-semibold">
              {t}
            </a>
          ))}
        </div>
        <button
          type="button"
          onClick={() => postOnX(`I just launched $${done.symbol} on Solana 🚀\n\nCA: ${done.mint}`, dexscreenerSol(done.mint))}
          className="h-11 w-full rounded-full bg-ink text-paper font-semibold"
        >
          Share on X
        </button>
        {!done.finished && pending && (
          <button type="button" onClick={() => void finish(pending)} disabled={busy} className="h-11 w-full rounded-full bg-emerald text-on-accent font-bold disabled:opacity-50">
            {busy ? step || "…" : "Finish"}
          </button>
        )}
        {error && <p className="text-[0.8125rem] text-danger">{error}</p>}
        <SolCashBack />
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <SolanaMark size={28} />
        <div className="min-w-0">
          <div className="font-semibold text-[0.9375rem]">Solana</div>
          <div className="text-[0.75rem] text-ink-3 truncate">
            {w.embedded ? "Paid from your Cash, in one step" : ext ? `${ext.name} · ${ext.address.slice(0, 4)}…${ext.address.slice(-4)}` : "Your Solana wallet signs"}
          </div>
        </div>
      </div>

      {pending && !busy && (
        <div className="rounded-2xl border border-line bg-night p-3 flex items-center gap-3">
          <CoinAvatar logo={pending.logo} symbol={pending.symbol} size={36} />
          <div className="min-w-0 flex-1 text-[0.8125rem]">
            <b className="block truncate">{pending.name}</b>
            <span className="text-ink-2">Needs one last step</span>
          </div>
          <button type="button" onClick={() => void finish(pending)} className="h-9 px-4 rounded-full bg-ink text-paper font-semibold text-[0.8125rem]">
            Finish
          </button>
        </div>
      )}

      {admin && (
        <label className="rounded-2xl border border-dashed border-line p-3 flex items-start gap-2.5 text-[0.8125rem] cursor-pointer">
          <input type="checkbox" checked={ownFee} onChange={(e) => setOwnFee(e.target.checked)} disabled={busy} className="mt-0.5" />
          <span>
            <b>Admin test: sasa&apos;s own fees</b>
            <span className="block text-ink-2">Trading fee 30% for the first 30 s, 15.5% until 60 s, then 1%. Not on pump.fun. Only admins see this.</span>
          </span>
        </label>
      )}

      <button
        type="button"
        onClick={() => void start()}
        disabled={busy || !!problem || !w.address}
        className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
      >
        {busy ? step || "Creating…" : "Create on Solana"}
      </button>
      {problem && !busy && <p className="text-[0.8125rem] text-ink-2 text-center">{problem}</p>}
      {error && <p className="text-[0.8125rem] text-danger text-center break-words">{error}</p>}
      {!busy && !problem && (
        <p className="text-[0.75rem] text-ink-3 text-center">
          {usdBuy > 0 ? `About $${(usdBuy + 5).toFixed(0)} from your Cash with the launch costs.` : "About $5 from your Cash for the launch costs."}
        </p>
      )}
    </div>
  );
}
