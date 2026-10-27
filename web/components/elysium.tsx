"use client";

/**
 * Elysium on sasa (admin-only until Elysium's mainnet): launch a coin, list the coins, and each
 * coin's page with buy and sell. Uses lib/elysium.ts; transactions go through the wallet's send().
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  elysiumFor,
  elysiumHref,
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
  if (!w.address)
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Elysium</h1>
        <p className="text-ink-2 mt-2">Launches and trading on Elysium open with its mainnet on November 9.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
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

function TestnetNote() {
  if (!ELYSIUM.testnet) return null;
  return (
    <p className="rounded-xl border border-line bg-paper px-3 py-2 text-[0.8125rem] text-ink-2">
      Admin test on Elysium testnet: needs a browser wallet (MetaMask) with test HYPE from the{" "}
      <a href="https://testnet.elysium.kinetiq.xyz/faucet" target="_blank" rel="noreferrer" className="text-emerald font-semibold">
        faucet
      </a>
      .
    </p>
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

  const load = useCallback(() => {
    fetchElysiumCoins()
      .then(setCoins)
      .catch(() => setCoins([]));
  }, []);
  useEffect(load, [load]);

  async function launch() {
    try {
      if (!name.trim() || !symbol.trim()) throw new Error("Add a name and a ticker.");
      if (!logo) throw new Error("Add a picture.");
      if (w.embedded) throw new Error("For the testnet, connect a browser wallet (MetaMask) with test HYPE.");
      setBusy("Saving the picture…");
      const info = await uploadElysiumInfo({ name: name.trim(), symbol: symbol.trim().toUpperCase(), description: description.trim(), image: logo });
      const fee = await elysiumLaunchFee();
      setBusy("Confirm in your wallet…");
      const tx = await w.send(ELYSIUM.chain, [launchCall({ name: name.trim(), symbol: symbol.trim().toUpperCase(), uri: info.uri, firstBuyWei: parseEther(buy || "0"), launchFeeWei: fee })], setBusy);
      const coin = await launchedCoin(tx);
      toast("Your coin is live on Elysium ✓");
      setName("");
      setSymbol("");
      setDescription("");
      setLogo("");
      load();
      if (coin) window.location.href = elysiumHref(coin);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-28 flex flex-col gap-5">
      <div>
        <h1 className="font-display font-bold text-[1.75rem]">Elysium</h1>
        <p className="text-ink-2 text-[0.9375rem]">Launch a coin on Elysium in one transaction: the whole supply goes into a locked HYPE pool and your first buy lands before anyone else.</p>
      </div>
      <TestnetNote />

      <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-3">
        <h2 className="font-semibold text-[1.0625rem]">Launch a coin</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} placeholder="Name" className="h-11 px-3 rounded-xl border border-line bg-paper" />
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10))} placeholder="Ticker" className="h-11 px-3 rounded-xl border border-line bg-paper uppercase" />
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} placeholder="Description (optional)" rows={2} className="px-3 py-2 rounded-xl border border-line bg-paper" />
        <div className="flex items-center gap-3">
          {logo ? <img src={logo} alt="" className="w-14 h-14 rounded-xl object-cover border border-line" /> : <div className="w-14 h-14 rounded-xl border border-dashed border-line" />}
          <label className="h-10 px-4 rounded-xl border border-line font-semibold text-[0.875rem] flex items-center cursor-pointer">
            Picture
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
        <label className="flex items-center gap-2 text-[0.875rem]">
          First buy
          <input value={buy} onChange={(e) => setBuy(e.target.value.replace(/[^0-9.]/g, ""))} className="w-28 h-10 px-3 rounded-xl border border-line bg-paper text-right" />
          HYPE
        </label>
        <button type="button" disabled={!!busy} onClick={launch} className="h-12 rounded-xl bg-emerald text-on-accent font-semibold disabled:opacity-60">
          {busy || "Launch on Elysium"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-[1.0625rem]">Coins on Elysium</h2>
        {coins === null && <div className="shimmer h-20 rounded-2xl" />}
        {coins && coins.length === 0 && <p className="text-ink-3 text-[0.875rem]">None yet.</p>}
        {coins?.map((c) => (
          <Link key={c.address} href={elysiumHref(c.address)} className="rounded-2xl border border-line bg-surface p-3 flex items-center gap-3 min-w-0">
            {c.image ? <img src={c.image} alt="" className="w-10 h-10 rounded-full object-cover" /> : <div className="w-10 h-10 rounded-full bg-paper border border-line" />}
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">
                {c.name} <span className="text-ink-3">${c.symbol}</span>
              </div>
              <div className="text-[0.75rem] text-ink-3">MC {fmtNum(c.mcHype)} HYPE</div>
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

  const load = useCallback(async () => {
    const c = await fetchElysiumCoin(address).catch(() => null);
    setCoin(c);
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
      if (w.embedded) throw new Error("For the testnet, connect a browser wallet (MetaMask) with test HYPE.");
      if (have !== undefined && raw > have) throw new Error(side === "buy" ? "Not enough HYPE." : `You don't have that many ${coin.symbol}.`);
      setBusy("Confirm in your wallet…");
      const calls = side === "buy" ? buyCalls(coin, w.address as Address, raw, SLIPPAGE_BPS) : sellCalls(coin, w.address as Address, raw, SLIPPAGE_BPS);
      await w.send(ELYSIUM.chain, calls, setBusy);
      toast(side === "buy" ? `Bought $${coin.symbol} ✓` : `Sold $${coin.symbol} ✓`);
      setAmount("");
      for (const ms of [0, 1500, 4000]) setTimeout(() => void load(), ms);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-28 flex flex-col gap-4">
      <TestnetNote />
      <div className="flex items-center gap-3 min-w-0">
        {coin.image ? <img src={coin.image} alt="" className="w-16 h-16 rounded-2xl object-cover" /> : <div className="w-16 h-16 rounded-2xl bg-paper border border-line" />}
        <div className="min-w-0">
          <h1 className="font-display font-bold text-[1.5rem] truncate">
            {coin.name} <span className="text-ink-3">${coin.symbol}</span>
          </h1>
          <div className="text-[0.8125rem] text-ink-3">Elysium · liquidity locked forever</div>
        </div>
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
        <button type="button" disabled={!!busy || raw <= 0n} onClick={trade} className="h-12 rounded-xl bg-emerald text-on-accent font-semibold disabled:opacity-60">
          {busy || (side === "buy" ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`)}
        </button>
      </div>

      <div className="text-[0.75rem] text-ink-3 break-all">
        Contract {coin.address} · Pool {coin.pool}
      </div>
    </div>
  );
}
