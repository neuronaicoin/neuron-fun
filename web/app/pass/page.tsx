"use client";

/**
 * The sasa Day-1 Pass: a free NFT on Elysium, one per wallet, minted by the wallet itself (only the
 * network fee; on the testnet that's faucet HYPE). Holders earn 2x points on Elysium launches and
 * trades (indexer/elysiumtest.mjs).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { toast } from "@/components/alerts";
import { friendlyError } from "@/lib/format";
import { ELYSIUM, ELYSIUM_PASS, FAUCET_URL, elysiumClient, elysiumHypeBalance, passAbi, testnetClosed } from "@/lib/elysium";

export default function Page() {
  const w = useWallet();
  const [count, setCount] = useState<number | null>(null);
  const [mine, setMine] = useState<boolean | null>(null);
  const [open, setOpen] = useState(true);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!ELYSIUM_PASS) return;
    const c = elysiumClient();
    const [n, o] = await Promise.all([
      c.readContract({ address: ELYSIUM_PASS, abi: passAbi, functionName: "totalSupply" }).catch(() => null),
      c.readContract({ address: ELYSIUM_PASS, abi: passAbi, functionName: "mintOpen" }).catch(() => true),
    ]);
    if (n !== null) setCount(Number(n));
    setOpen(o !== false);
    if (w.address) {
      const [m, g] = await Promise.all([
        c.readContract({ address: ELYSIUM_PASS, abi: passAbi, functionName: "minted", args: [w.address as Address] }).catch(() => null),
        elysiumHypeBalance(w.address as Address).catch(() => null),
      ]);
      setMine(m);
      setGas(g);
    }
  }, [w.address]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function mint() {
    if (!ELYSIUM_PASS || !w.address) return;
    try {
      setBusy("Minting…");
      await (w.embedded ? w.sendOwnGas : w.send)(ELYSIUM.chain, [{ to: ELYSIUM_PASS, data: encodeFunctionData({ abi: passAbi, functionName: "mint" }) }], setBusy);
      setMine(true);
      toast("Your Day-1 Pass is minted ✓ 2x points are on");
      void load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const noGas = gas !== null && gas === 0n;
  const share = `https://x.com/intent/post?text=${encodeURIComponent("just minted my sasa Day-1 Pass on Elysium 🎟️ free, one per wallet, 2x points on every launch and trade\n\ngrab yours 👇")}&url=${encodeURIComponent("https://sasapad.fun/pass/")}`;
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-28 md:pb-12">
      <div className="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pass.png" alt="sasa Day-1 Pass" width={1000} height={1000} className="w-full rounded-3xl border border-line" />
        <div>
          <span className="inline-block text-[0.75rem] font-extrabold tracking-wide px-2.5 py-1 rounded-full bg-emerald-soft text-emerald">
            {ELYSIUM.testnet ? "ELYSIUM TESTNET · FREE" : "ELYSIUM · FREE"}
          </span>
          <h1 className="mt-3 font-display font-bold text-[2rem] sm:text-[2.5rem] leading-tight tracking-tight">sasa Day-1 Pass</h1>
          <p className="mt-2 text-ink-2 text-[0.9375rem]">Free, one per wallet. Holders earn <b className="text-ink">2x sasa points</b> on every Elysium launch and trade, forever.</p>
          <ul className="mt-4 grid gap-1.5 text-[0.875rem]">
            <li>🎟️ Mint: +50 points</li>
            <li>🚀 Every launch: 100 instead of 50</li>
            <li>🔁 Every trade: 20 instead of 10</li>
          </ul>
          {count !== null && <p className="mt-4 font-display font-bold text-[1.25rem]">{count.toLocaleString("en-US")} minted</p>}

          {!ELYSIUM_PASS ? (
            <p className="mt-5 rounded-2xl bg-paper border border-line px-4 py-3 text-[0.875rem]">Minting opens very soon. Follow @sasapadfun to catch it.</p>
          ) : !w.address ? (
            <div className="mt-5">
              <ConnectButton />
            </div>
          ) : mine ? (
            <div className="mt-5 grid gap-2">
              <p className="rounded-2xl bg-up/10 border border-up/30 px-4 py-3 font-semibold">✅ You have your pass. 2x points are on.</p>
              <a href={share} target="_blank" rel="noreferrer" className="h-12 rounded-2xl bg-ink text-mist font-bold grid place-items-center">
                Share on X
              </a>
              <Link href="/elysium/" className="h-12 rounded-2xl border border-line font-bold grid place-items-center">
                Launch a coin on Elysium →
              </Link>
            </div>
          ) : testnetClosed() ? (
            <p className="mt-5 rounded-2xl bg-paper border border-line px-4 py-3 text-[0.875rem]">The testnet pass is closed. The mainnet Day-1 Pass opens on November 9.</p>
          ) : !open ? (
            <p className="mt-5 rounded-2xl bg-paper border border-line px-4 py-3 text-[0.875rem]">Minting has ended.</p>
          ) : (
            <div className="mt-5 grid gap-2">
              <button type="button" disabled={!!busy || noGas} onClick={() => void mint()} className="w-full h-13 rounded-2xl bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50">
                {busy || "Mint free"}
              </button>
              {noGas && ELYSIUM.testnet && (
                <p className="text-[0.8125rem] text-ink-2">
                  You need a little test HYPE for the network fee.{" "}
                  <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="text-emerald font-semibold">
                    Get it free from the faucet →
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
