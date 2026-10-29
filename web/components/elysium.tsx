"use client";

/**
 * Elysium on sasa: launch a coin, list the coins, and each coin's page with buy and sell. Before
 * Elysium's mainnet (Nov 9) it runs on the public testnet with free test HYPE, marked TESTNET everywhere. Uses lib/elysium.ts; transactions go through the wallet's send().
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseEther, parseUnits, type Address } from "viem";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { toast } from "./alerts";
import { friendlyError } from "@/lib/format";
import { fileToBigLogo } from "@/lib/image";
import {
  ELYSIUM,
  buyCalls,
  elysiumBalances,
  FAUCET_URL,
  ELYSIUM_PASS,
  elysiumFor,
  elysiumHref,
  elysiumHypeBalance,
  elysiumLaunchFee,
  fetchElysiumCoin,
  fetchElysiumCoins,
  fmtHype,
  launchCall,
  launchedCoin,
  quoteOut,
  sellCalls,
  uploadElysiumInfo,
  type ElysiumCoin,
  BOOST_DAYS,
  BOOST_X,
  DAY1_COINS,
  ELYSIUM_BOOST_END,
  testnetClosed,
  FAUCET_RULE,
  boostLive,
  elysiumDay1,
} from "@/lib/elysium";
import { addHype, elysiumTopupReady, HYPE_GAS_FLOOR, HYPE_TOPUPS } from "@/lib/elysiumgas";

const SLIPPAGE_BPS = 500;
const fmtNum = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

function Gate({ children }: { children: React.ReactNode }) {
  const w = useWallet();
  if (testnetClosed())
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">The testnet is closed</h1>
        <p className="text-ink-2 mt-2">Thanks for testing. Your points are saved. Elysium mainnet opens on sasa on November 9: real coins, 3x points the first week.</p>
        <Link href="/points/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">
          See your points
        </Link>
      </div>
    );
  if (!elysiumFor(w.address))
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Elysium is coming</h1>
        <p className="text-ink-2 mt-2">Launch and trade Elysium coins straight from your USDC balance, from November 9.</p>
        <Link href="/learn/what-is-elysium/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">
          What is Elysium?
        </Link>
      </div>
    );
  return <>{children}</>;
}

/** The stripe on every Elysium testnet page: nobody mistakes test coins for real ones. */
function TestnetBand() {
  if (!ELYSIUM.testnet) return null;
  return (
    <div
      className="rounded-2xl text-white px-3.5 sm:px-4 py-2.5 flex items-start sm:items-center gap-2.5 text-[0.8125rem] sm:text-[0.875rem] leading-snug"
      style={{ background: "repeating-linear-gradient(135deg,#1a1410 0 12px,#241b14 12px 24px)" }}
      role="note"
    >
      <span className="shrink-0 text-[0.625rem] font-black tracking-[0.12em] px-2 py-1 rounded-md bg-[#ffc23d] text-[#1a1410]">TESTNET</span>
      <span>
        Free test HYPE only. Nothing here has real value. Mainnet opens <b>Nov 9</b>.{" "}
        <Link href="/learn/what-is-elysium/" className="text-[#ffb27a] font-semibold whitespace-nowrap">
          What is Elysium? →
        </Link>
      </span>
    </div>
  );
}

/** A ready X post for an Elysium coin (the creator's own words when it's theirs). */
function shareUrl(coin: ElysiumCoin, mine: boolean) {
  const link = `https://sasapad.fun${elysiumHref(coin.address)}`;
  const text = mine
    ? `just launched $${coin.symbol} on Elysium ${ELYSIUM.testnet ? "testnet " : ""}with @sasapadfun 🚀\n\none tx, liquidity locked forever. ${ELYSIUM.testnet ? "free to try before mainnet 👇" : "go 👇"}`
    : `$${coin.symbol} on Elysium ${ELYSIUM.testnet ? "testnet " : ""}via @sasapadfun 👀`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
}

function ShareButton({ coin, mine, big = false }: { coin: ElysiumCoin; mine: boolean; big?: boolean }) {
  return (
    <a
      href={shareUrl(coin, mine)}
      target="_blank"
      rel="noreferrer"
      className={
        "inline-flex items-center justify-center gap-2 rounded-xl font-bold " +
        (big ? "h-12 px-5 bg-ink text-mist text-[0.9375rem]" : "h-9 px-3.5 border border-line text-[0.8125rem] hover:border-ink/40")
      }
    >
      <span aria-hidden="true">𝕏</span> {mine ? "Share your coin" : "Share"}
    </a>
  );
}

const TestTag = () =>
  ELYSIUM.testnet ? <span className="ml-1.5 align-[0.15em] text-[0.625rem] font-extrabold tracking-wide px-1.5 py-0.5 rounded bg-warn-bg text-warn-ink">TEST</span> : null;

/** The permanent badge of the first DAY1_COINS coins on Elysium mainnet. */
const Day1Badge = ({ big = false }: { big?: boolean }) => (
  <span
    title={`One of the first ${DAY1_COINS} coins launched on Elysium mainnet`}
    className={
      "ml-1.5 align-[0.15em] font-extrabold tracking-wide rounded bg-[#ffc23d] text-[#1a1410] whitespace-nowrap " +
      (big ? "text-[0.6875rem] px-2 py-0.5" : "text-[0.5625rem] px-1.5 py-0.5")
    }
  >
    🏅 DAY-1
  </span>
);

/** The first DAY1_COINS coins (mainnet), refreshed with the list. */
function useDay1(): { set: Set<string>; count: number } | null {
  const [d, setD] = useState<{ set: Set<string>; count: number } | null>(null);
  useEffect(() => {
    if (ELYSIUM.testnet) return;
    let alive = true;
    const go = () => elysiumDay1().then((x) => alive && setD(x)).catch(() => {});
    go();
    const t = setInterval(() => document.visibilityState === "visible" && go(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return d;
}

/**
 * Mainnet's launch week. Before mainnet: what's coming (3x points, the Day-1 badge). On mainnet:
 * the 3x countdown and how many Day-1 spots are left.
 */
function LaunchWeek({ day1 }: { day1: { count: number } | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const left = day1 ? Math.max(0, DAY1_COINS - day1.count) : null;
  if (ELYSIUM.testnet)
    return (
      <div className="rounded-2xl border border-[#ffc23d]/50 bg-[#ffc23d]/10 px-4 py-3 text-[0.8125rem] sm:text-[0.875rem] text-ink-2 leading-snug">
        <b className="text-ink">Mainnet week one (from Nov 9):</b> every launch and trade earns <b className="text-ink">{BOOST_X}x points</b> for {BOOST_DAYS} days ({BOOST_X * 2}x with a Day-1 Pass), and the first {DAY1_COINS} coins get a permanent <Day1Badge />
      </div>
    );
  const live = boostLive();
  if (!live && left === 0) return null;
  const end = ELYSIUM_BOOST_END ? new Date(ELYSIUM_BOOST_END) : null;
  const hoursLeft = end ? Math.max(0, Math.floor((end.getTime() - Date.now()) / 3_600_000)) : 0;
  return (
    <div className="rounded-2xl border border-[#ffc23d]/60 bg-[#ffc23d]/15 px-4 py-3 flex flex-col gap-1 text-[0.8125rem] sm:text-[0.875rem] text-ink-2 leading-snug">
      {live && (
        <span>
          🔥 <b className="text-ink">{BOOST_X}x points week</b>: every launch and trade earns {BOOST_X}x ({BOOST_X * 2}x with a Day-1 Pass).{" "}
          <b className="text-ink">{hoursLeft >= 24 ? `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h` : `${hoursLeft}h`} left</b>
        </span>
      )}
      {left !== null && left > 0 && (
        <span>
          🏅 <b className="text-ink">{left} of {DAY1_COINS} Day-1 spots left</b>: the first {DAY1_COINS} coins keep the <Day1Badge /> badge for good.
        </span>
      )}
    </div>
  );
}

/** Cash → HYPE on Elysium, one tap (mainnet). The user pays the swap and network costs. */
function HypeTopup({ hype, onDone, compact = false }: { hype: bigint | null; onDone: () => void; compact?: boolean }) {
  const w = useWallet();
  const [busy, setBusy] = useState("");
  if (!w.address || !elysiumTopupReady()) return null;
  const low = hype !== null && hype < HYPE_GAS_FLOOR;
  async function go(usd: number) {
    try {
      setBusy("Getting the price…");
      const got = await addHype({ user: w.address as Address, usd, send: w.send, onStep: setBusy });
      toast(got === null ? `$${usd} of HYPE is on its way to Elysium (usually under a minute)` : `HYPE added ✓ You have ${fmtHype(got)} HYPE`);
      onDone();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className={"rounded-2xl border px-3.5 py-3 flex flex-col sm:flex-row sm:items-center gap-2.5 " + (low ? "border-emerald/50 bg-emerald-soft" : "border-line bg-surface")}>
      <span className="min-w-0 flex-1 text-[0.8125rem] sm:text-[0.875rem] text-ink-2 leading-snug">
        ⛽ <b className="text-ink">{low ? "You need HYPE here" : "Add HYPE"}</b>
        {compact ? "" : ` — from your cash, one tap. ${low ? "It pays the network fee and your buys." : ""}`}
      </span>
      <span className="flex gap-1.5 shrink-0">
        {busy ? (
          <span className="h-9 px-3 rounded-lg border border-line text-[0.8125rem] grid place-items-center text-ink-3">{busy}</span>
        ) : (
          HYPE_TOPUPS.map((usd) => (
            <button key={usd} type="button" onClick={() => void go(usd)} className="h-9 px-3 rounded-lg border border-emerald text-emerald font-bold text-[0.8125rem] bg-surface">
              +${usd}
            </button>
          ))
        )}
      </span>
    </div>
  );
}

/** Copies the account's address (email accounts paste it into the faucet). */
function CopyAddress({ address }: { address: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(address)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          })
          .catch(() => toast(address));
      }}
      className="h-8 px-3 rounded-lg bg-emerald text-on-accent font-bold text-[0.75rem] whitespace-nowrap"
    >
      {done ? "Copied ✓" : "Copy address"}
    </button>
  );
}

// ------------------------------------------------------------------ launch + list

export function ElysiumHome() {
  return (
    <Gate>
      <ElysiumHomeInner />
    </Gate>
  );
}

function ElysiumHomeInner() {
  const w = useWallet();
  const [coins, setCoins] = useState<ElysiumCoin[] | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState<string>("");
  const [buy, setBuy] = useState("0.001");
  const [busy, setBusy] = useState("");
  const [hype, setHype] = useState<bigint | null>(null);
  const test = ELYSIUM.testnet;
  const unit = test ? "test HYPE" : "HYPE";

  const load = useCallback(() => {
    fetchElysiumCoins()
      .then(setCoins)
      .catch(() => setCoins([]));
  }, []);
  useEffect(load, [load]);
  const loadBal = useCallback(() => {
    if (!w.address) return setHype(null);
    elysiumHypeBalance(w.address as Address)
      .then(setHype)
      .catch(() => {});
  }, [w.address]);
  useEffect(() => {
    loadBal();
    const t = setInterval(() => document.visibilityState === "visible" && loadBal(), 15_000);
    return () => clearInterval(t);
  }, [loadBal]);

  async function launch() {
    try {
      if (!w.address) throw new Error("Log in first (step 1).");
      if (!name.trim() || !symbol.trim()) throw new Error("Add a name and a ticker.");
      if (!logo) throw new Error("Add a picture.");
      let first = 0n;
      try {
        first = parseEther(buy || "0");
      } catch {
        throw new Error("The first buy isn't a number.");
      }
      if (!test && w.address && elysiumTopupReady()) {
        // mainnet: missing HYPE comes from the user's cash first, in the same tap
        const need = first + (await elysiumLaunchFee()) + HYPE_GAS_FLOOR;
        const now = await elysiumHypeBalance(w.address as Address).catch(() => hype ?? 0n);
        if (now < need) {
          const got = await addHype({ user: w.address as Address, hypeOut: need - now, send: w.send, onStep: setBusy });
          if (got === null) throw new Error("Your HYPE is still on its way. Tap Launch again in a few seconds.");
          setHype(got);
        }
      } else if (hype !== null && hype < first + 300_000_000_000_000n)
        throw new Error(
          test
            ? hype === 0n
              ? `You have no ${unit} yet: get some free from the faucet (step 2).`
              : `Not enough ${unit} for this first buy plus the network fee. Lower it, or get more from the faucet.`
            : `Not enough HYPE for this first buy plus the network fee.`
        );
      setBusy("Saving the picture…");
      const info = await uploadElysiumInfo({ name: name.trim(), symbol: symbol.trim().toUpperCase(), description: description.trim(), image: logo });
      const fee = await elysiumLaunchFee();
      setBusy("Confirm in your wallet…");
      const tx = await (w.embedded ? w.sendOwnGas : w.send)(ELYSIUM.chain, [launchCall({ name: name.trim(), symbol: symbol.trim().toUpperCase(), uri: info.uri, firstBuyWei: first, launchFeeWei: fee })], setBusy);
      const coin = await launchedCoin(tx);
      toast(test ? "Your test coin is live on Elysium testnet ✓" : "Your coin is live on Elysium ✓");
      setName("");
      setSymbol("");
      setDescription("");
      setLogo("");
      load();
      if (coin) window.location.href = elysiumHref(coin) + "&new=1";
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const day1 = useDay1();
  const people = coins ? new Set(coins.map((c) => c.creator.toLowerCase())).size : 0;
  const Step = ({ n, done, title, text, children }: { n: number; done?: boolean; title: string; text: string; children?: React.ReactNode }) => (
    <div className="rounded-2xl border border-line bg-surface p-3 sm:p-4 flex items-center sm:items-start gap-3 min-w-0">
      <span className={"w-7 h-7 rounded-full grid place-items-center font-black text-[0.8125rem] shrink-0 " + (done ? "bg-up/15 text-up" : "bg-emerald-soft text-emerald")}>{done ? "✓" : n}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[0.9375rem]">{title}</span>
        <span className="block text-[0.75rem] sm:text-[0.8125rem] text-ink-3 leading-snug">{text}</span>
      </span>
      {children}
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 sm:py-6 pb-28 flex flex-col gap-4 sm:gap-5">
      <TestnetBand />
      <div>
        <h1 className="font-display font-extrabold text-[1.75rem] sm:text-[2.25rem] leading-tight flex items-center gap-2.5 flex-wrap">
          Launch on Elysium
          {test && <span className="text-[0.6875rem] font-extrabold tracking-[0.08em] px-2.5 py-1 rounded-full bg-warn-bg text-warn-ink border border-mint/40">TESTNET · FREE</span>}
        </h1>
        <p className="text-ink-2 text-[0.9375rem] sm:text-[1rem] mt-1.5">
          One transaction: your coin goes live with its whole supply in a locked HYPE pool, and your first buy lands before anyone else.
          {test && " Try it free before mainnet."}
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-2 sm:gap-3">
        <Step
          n={1}
          done={!!w.address}
          title={w.address ? "Logged in" : "Log in"}
          text={w.address ? `${w.address.slice(0, 6)}…${w.address.slice(-4)}` : "Email, Google or any wallet"}
        >
          {!w.address && (
            <span className="shrink-0 sm:hidden">
              <ConnectButton />
            </span>
          )}
        </Step>
        {test && (
          <Step
            n={2}
            done={hype !== null && hype > 0n}
            title="Get test HYPE"
            text={hype !== null && hype > 0n ? `You have ${fmtHype(hype)} test HYPE` : `${FAUCET_RULE} No HYPE? Wait for mainnet on Nov 9: you'll start with your USDC.`}
          >
            <span className="shrink-0 flex flex-col sm:flex-row gap-1.5">
              {w.address && !(hype !== null && hype > 0n) && <CopyAddress address={w.address} />}
              <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-lg border border-emerald text-emerald font-bold text-[0.75rem] grid place-items-center whitespace-nowrap">
                Faucet ↗
              </a>
            </span>
          </Step>
        )}
        {!test && (
          <Step n={2} done={hype !== null && hype >= HYPE_GAS_FLOOR} title="Have some HYPE" text={hype !== null && hype > 0n ? `You have ${fmtHype(hype)} HYPE` : "Comes from your cash by itself when you launch or buy"} />
        )}
        <Step n={3} title="Launch your coin" text="Name, ticker, picture. Live in seconds." />
      </div>
      {!w.address && (
        <div className="hidden sm:block">
          <ConnectButton full />
        </div>
      )}
      <HypeTopup hype={hype} onDone={loadBal} />
      <LaunchWeek day1={day1} />

      {test && (
        <Link href="/points/" className="rounded-2xl border border-emerald/40 bg-emerald-soft px-4 py-3 flex items-center gap-3 text-[0.8125rem] sm:text-[0.875rem]">
          <span className="text-[1.25rem]" aria-hidden="true">🪂</span>
          <span className="min-w-0 flex-1 text-ink-2">
            <b className="text-ink">Earn sasa airdrop points on testnet:</b> 100 for your first launch, 50 a launch (3 a day), 10 a trade (10 a day).
          </span>
          <span className="text-emerald font-bold shrink-0">→</span>
        </Link>
      )}

      {ELYSIUM_PASS && (
        <Link href="/pass/" className="rounded-2xl border border-mint/40 bg-warn-bg/50 px-4 py-3 flex items-center gap-3 text-[0.8125rem] sm:text-[0.875rem]">
          <span className="text-[1.25rem]" aria-hidden="true">🎟️</span>
          <span className="min-w-0 flex-1 text-ink-2">
            <b className="text-ink">Mint your free Day-1 Pass</b> and earn 2x points on every launch and trade here.
          </span>
          <span className="text-emerald font-bold shrink-0">→</span>
        </Link>
      )}

      <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-3">
        <h2 className="font-display font-bold text-[1.125rem] sm:text-[1.25rem]">{test ? "Create a test coin" : "Create a coin"}</h2>
        <div className="grid grid-cols-[1.4fr_1fr] gap-2 sm:gap-3">
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="Name" className="h-12 px-3.5 rounded-xl border border-line bg-paper min-w-0" />
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10))} placeholder="TICKER" className="h-12 px-3.5 rounded-xl border border-line bg-paper uppercase min-w-0" />
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} placeholder="What's the story? (optional)" rows={2} className="px-3.5 py-2.5 rounded-xl border border-line bg-paper" />
        <div className="flex items-center gap-3">
          {logo ? <img src={logo} alt="" className="w-14 h-14 rounded-xl object-cover border border-line" /> : <div className="w-14 h-14 rounded-xl border border-dashed border-line grid place-items-center text-ink-3 text-[1.25rem]">+</div>}
          <label className="h-10 px-4 rounded-xl border border-line font-semibold text-[0.875rem] flex items-center cursor-pointer">
            {logo ? "Change picture" : "Add a picture"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setLogo(await fileToBigLogo(f).catch(() => ""));
              }}
            />
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[0.875rem]">
          <span>First buy</span>
          {["0", "0.001", "0.005"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setBuy(v)}
              className={"h-9 px-3 rounded-lg font-bold text-[0.8125rem] " + (buy === v ? "border border-emerald text-emerald bg-emerald-soft" : "border border-line")}
            >
              {v}
            </button>
          ))}
          <input
            value={buy}
            onChange={(e) => setBuy(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            aria-label="First buy"
            className="hidden sm:block w-24 h-9 px-2.5 rounded-lg border border-line bg-paper text-right"
          />
          <span className="text-ink-3">{unit}</span>
        </div>
        <button type="button" disabled={!!busy} onClick={launch} className="mt-1 h-13 min-h-[3.25rem] rounded-xl bg-emerald text-on-accent font-bold text-[1rem] disabled:opacity-60">
          {busy || (test ? "Launch on Elysium testnet" : "Launch on Elysium")}
        </button>
        {hype !== null && (
          <p className="text-center text-[0.75rem] text-ink-3">
            You have {fmtHype(hype)} {unit} · network fee about 0.0006
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-display font-bold text-[1.125rem] flex items-baseline justify-between gap-3">
          {test ? "Test coins on Elysium" : "Coins on Elysium"}
          {people > 0 && <span className="font-sans font-medium text-[0.8125rem] text-ink-3">launched by {people} {people === 1 ? "person" : "people"}</span>}
        </h2>
        {coins === null && <div className="shimmer h-20 rounded-2xl" />}
        {coins && coins.length === 0 && <p className="text-ink-3 text-[0.875rem]">None yet. Be the first.</p>}
        {coins?.map((c) => (
          <Link key={c.address} href={elysiumHref(c.address)} className="rounded-2xl border border-line bg-surface p-3 flex items-center gap-3 min-w-0 hover:border-emerald/40">
            {c.image ? <img src={c.image} alt="" className="w-11 h-11 rounded-xl object-cover" /> : <div className="w-11 h-11 rounded-xl bg-paper border border-line" />}
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">
                {c.name} <span className="text-ink-3 font-normal">${c.symbol}</span>
                <TestTag />
                {day1?.set.has(c.address.toLowerCase()) && <Day1Badge />}
              </div>
              <div className="text-[0.75rem] text-ink-3 truncate">
                by {c.creator.slice(0, 6)}…{c.creator.slice(-4)}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-display font-bold text-[0.9375rem]">{fmtNum(c.mcHype)} HYPE</div>
              <div className="text-[0.6875rem] text-ink-3">market cap</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ coin page

export function ElysiumCoinPage({ address }: { address: string }) {
  return (
    <Gate>
      <ElysiumCoinInner address={address} />
    </Gate>
  );
}

function ElysiumCoinInner({ address }: { address: string }) {
  const w = useWallet();
  const [coin, setCoin] = useState<ElysiumCoin | null | undefined>(undefined);
  const [bal, setBal] = useState<{ hype: bigint; coin: bigint } | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");

  const day1 = useDay1();
  const misses = useRef(0);
  const load = useCallback(async () => {
    let c = await fetchElysiumCoin(address).catch(() => null);
    // a coin launched a moment ago: the public node can be a few blocks behind, try again first
    for (let k = 0; !c && k < 3 && misses.current === 0; k++) {
      await new Promise((r) => setTimeout(r, 2500));
      c = await fetchElysiumCoin(address).catch(() => null);
    }
    if (!c) misses.current++;
    setCoin((x) => c ?? (x ? x : null));
    if (c && w.address) setBal(await elysiumBalances(w.address as Address, c.address).catch(() => null));
  }, [address, w.address]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (coin === undefined) return <div className="max-w-3xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  if (coin === null)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Coin not found</h1>
        <p className="text-ink-2 mt-2">This isn&apos;t a coin launched on sasa on Elysium.</p>
        <Link href="/elysium/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Elysium coins</Link>
      </div>
    );

  const mine = !!w.address && coin.creator.toLowerCase() === w.address.toLowerCase();
  const fresh = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1";
  let raw = 0n;
  try {
    raw = amount ? (side === "buy" ? parseEther(amount) : parseUnits(amount, 18)) : 0n;
  } catch {
    raw = 0n;
  }
  const out = raw > 0n ? quoteOut(coin, side, raw) : 0n;
  const have = side === "buy" ? bal?.hype : bal?.coin;

  async function trade() {
    if (!coin || !w.address || raw <= 0n) return;
    try {
      // Mainnet: not enough HYPE? It comes from the user's cash first, in the same tap: exactly what
      // this buy needs (plus the network fee), or a little for a sale's fee.
      let haveNow = have;
      if (!ELYSIUM.testnet && bal && elysiumTopupReady()) {
        const need = side === "buy" ? raw + HYPE_GAS_FLOOR : HYPE_GAS_FLOOR;
        if (bal.hype < need) {
          const got = await addHype({ user: w.address as Address, hypeOut: need - bal.hype, send: w.send, onStep: setBusy });
          if (got === null) throw new Error("Your HYPE is still on its way. Tap again in a few seconds.");
          if (side === "buy") haveNow = got;
        }
      }
      if (haveNow !== undefined && raw > haveNow) throw new Error(side === "buy" ? "Not enough HYPE." : `You don't have that many ${coin.symbol}.`);
      setBusy("Confirm in your wallet…");
      const calls = side === "buy" ? buyCalls(coin, w.address as Address, raw, SLIPPAGE_BPS) : sellCalls(coin, w.address as Address, raw, SLIPPAGE_BPS);
      await (w.embedded ? w.sendOwnGas : w.send)(ELYSIUM.chain, calls, setBusy);
      toast((side === "buy" ? `Bought $${coin.symbol} ✓` : `Sold $${coin.symbol} ✓`) + (ELYSIUM.testnet ? " · +10 airdrop points" : boostLive() ? ` · ${BOOST_X}x points week` : ""));
      setAmount("");
      for (const ms of [0, 1500, 4000]) setTimeout(() => void load(), ms);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 sm:py-6 pb-28 flex flex-col gap-4">
      <TestnetBand />
      {fresh && mine && (
        <div className="rounded-3xl border border-up/30 bg-up/[0.07] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-display font-bold text-[1.125rem]">🎉 ${coin.symbol} is live{ELYSIUM.testnet ? " on testnet" : ""}</div>
            <div className="text-[0.8125rem] text-ink-2">
              {ELYSIUM.testnet ? "You earned airdrop points for it. " : ""}Share it so people trade it.
            </div>
          </div>
          <ShareButton coin={coin} mine big />
        </div>
      )}
      <div className="flex items-center gap-3 min-w-0">
        {coin.image ? <img src={coin.image} alt="" className="w-16 h-16 rounded-2xl object-cover" /> : <div className="w-16 h-16 rounded-2xl bg-paper border border-line" />}
        <div className="min-w-0">
          <h1 className="font-display font-bold text-[1.5rem] truncate">
            {coin.name} <span className="text-ink-3">${coin.symbol}</span>
            <TestTag />
            {day1?.set.has(coin.address.toLowerCase()) && <Day1Badge big />}
          </h1>
          <div className="text-[0.8125rem] text-ink-3">{ELYSIUM.testnet ? "Elysium testnet" : "Elysium"} · liquidity locked forever</div>
        </div>
        <span className="ml-auto shrink-0">
          <ShareButton coin={coin} mine={mine} />
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-line bg-surface p-3">
          <div className="text-[0.75rem] text-ink-3">Market cap</div>
          <div className="font-semibold text-[1.125rem]">{fmtNum(coin.mcHype)} HYPE</div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3">
          <div className="text-[0.75rem] text-ink-3">Price</div>
          <div className="font-semibold text-[1.125rem]">{coin.priceHype.toExponential(3)} HYPE</div>
        </div>
      </div>
      {coin.description && <p className="text-ink-2">{coin.description}</p>}

      <div className="rounded-3xl border border-line bg-surface p-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setAmount("");
              }}
              className={"h-10 rounded-xl font-semibold " + (side === s ? (s === "buy" ? "bg-up text-white" : "bg-danger text-white") : "border border-line")}
            >
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
            inputMode="decimal"
            className="flex-1 h-12 px-3 rounded-xl border border-line bg-paper text-[1.125rem]"
          />
          <span className="font-semibold">{side === "buy" ? "HYPE" : coin.symbol}</span>
        </div>
        <div className="flex justify-between text-[0.8125rem] text-ink-3">
          <span>
            You have {have === undefined ? "…" : side === "buy" ? `${fmtHype(have)} HYPE` : `${fmtNum(Number(have) / 1e18)} ${coin.symbol}`}
          </span>
          {side === "sell" && bal && bal.coin > 0n && (
            <button type="button" className="text-emerald font-semibold" onClick={() => setAmount((Number(bal.coin) / 1e18).toString())}>
              Max
            </button>
          )}
        </div>
        {raw > 0n && (
          <div className="text-[0.875rem]">
            You get about <b>{side === "buy" ? `${fmtNum(Number(out) / 1e18)} ${coin.symbol}` : `${fmtHype(out)} HYPE`}</b>
          </div>
        )}
        {!w.address ? (
          <ConnectButton full />
        ) : (
          <button type="button" disabled={!!busy || raw <= 0n} onClick={trade} className="h-12 rounded-xl bg-emerald text-on-accent font-semibold disabled:opacity-60">
            {busy || (side === "buy" ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`)}
          </button>
        )}
        {!ELYSIUM.testnet && bal && (side === "buy" || bal.hype < HYPE_GAS_FLOOR) && (
          <HypeTopup hype={bal.hype} onDone={() => void load()} compact={bal.hype >= HYPE_GAS_FLOOR} />
        )}
        {ELYSIUM.testnet && side === "buy" && bal && bal.hype === 0n && (
          <p className="text-[0.75rem] text-ink-3">
            No test HYPE yet? {FAUCET_RULE}{" "}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="text-emerald font-semibold">
              Faucet ↗
            </a>{" "}
            No HYPE? Mainnet opens Nov 9, with your USDC.
          </p>
        )}
      </div>

      <div className="text-[0.75rem] text-ink-3 break-all">
        Contract {coin.address} · Pool {coin.pool}
      </div>
    </div>
  );
}
