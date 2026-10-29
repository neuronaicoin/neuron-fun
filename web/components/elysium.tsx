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
} from "@/lib/elysium";

const SLIPPAGE_BPS = 500;
const fmtNum = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

function Gate({ children }: { children: React.ReactNode }) {
  const w = useWallet();
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
  const browser = !!w.address && !w.embedded;
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
      if (!w.address) throw new Error("Log in with MetaMask first (step 1).");
      if (w.embedded) throw new Error("The testnet needs a browser wallet like MetaMask. Log out and log in with MetaMask.");
      if (!name.trim() || !symbol.trim()) throw new Error("Add a name and a ticker.");
      if (!logo) throw new Error("Add a picture.");
      let first = 0n;
      try {
        first = parseEther(buy || "0");
      } catch {
        throw new Error("The first buy isn't a number.");
      }
      if (hype !== null && hype < first + 300_000_000_000_000n)
        throw new Error(hype === 0n ? `You have no ${unit} yet: get some free from the faucet (step 2).` : `Not enough ${unit} for this first buy plus the network fee. Lower it, or get more from the faucet.`);
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
        <Step n={1} done={browser} title={browser ? "Wallet connected" : "Connect MetaMask"} text={browser ? `${w.address!.slice(0, 6)}…${w.address!.slice(-4)}` : w.address ? "Email accounts can't use the testnet: log in with MetaMask" : "Any browser wallet works"}>
          {!w.address && (
            <span className="shrink-0 sm:hidden">
              <ConnectButton />
            </span>
          )}
        </Step>
        {test && (
          <Step n={2} done={hype !== null && hype > 0n} title="Get free test HYPE" text={hype !== null && hype > 0n ? `You have ${fmtHype(hype)} test HYPE` : "From Kinetiq's faucet, once every 12 hours"}>
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="shrink-0 h-8 px-3 rounded-lg border border-emerald text-emerald font-bold text-[0.75rem] grid place-items-center whitespace-nowrap">
              Faucet ↗
            </a>
          </Step>
        )}
        <Step n={test ? 3 : 2} title="Launch your coin" text="Name, ticker, picture. Live in seconds." />
      </div>
      {!w.address && (
        <div className="hidden sm:block">
          <ConnectButton full />
        </div>
      )}

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
      if (w.embedded) throw new Error("The testnet needs a browser wallet like MetaMask. Log out and log in with MetaMask.");
      if (have !== undefined && raw > have) throw new Error(side === "buy" ? "Not enough HYPE." : `You don't have that many ${coin.symbol}.`);
      setBusy("Confirm in your wallet…");
      const calls = side === "buy" ? buyCalls(coin, w.address as Address, raw, SLIPPAGE_BPS) : sellCalls(coin, w.address as Address, raw, SLIPPAGE_BPS);
      await (w.embedded ? w.sendOwnGas : w.send)(ELYSIUM.chain, calls, setBusy);
      toast((side === "buy" ? `Bought $${coin.symbol} ✓` : `Sold $${coin.symbol} ✓`) + (ELYSIUM.testnet ? " · +10 airdrop points" : ""));
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
        {ELYSIUM.testnet && side === "buy" && bal && bal.hype === 0n && (
          <p className="text-[0.75rem] text-ink-3">
            No test HYPE yet?{" "}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="text-emerald font-semibold">
              Get some free from the faucet ↗
            </a>
          </p>
        )}
      </div>

      <div className="text-[0.75rem] text-ink-3 break-all">
        Contract {coin.address} · Pool {coin.pool}
      </div>
    </div>
  );
}
