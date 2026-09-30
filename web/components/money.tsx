"use client";

/**
 * Deposit (from any chain, into the sasa wallet as ETH) and Withdraw (to any
 * chain, wallet or exchange). Routes come live from Relay; sasa adds no fee.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, numberToHex, parseEther, type Address, type Hex } from "viem";
import { Sheet } from "./chrome";
import { useWallet, WALLETCONNECT_ID, type Eip1193, type WalletOption } from "./wallet";
import { toast } from "./alerts";
import { CHAINS, type NeuronChain } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { cashOf } from "@/lib/portfolio";
import { friendlyError } from "@/lib/format";
import {
  NATIVE,
  RELAY_API,
  addressFromQr,
  depositsTo,
  fmtAmount,
  fmtUsd,
  getQuote,
  isEvmAddress,
  isSolanaAddress,
  refundFor,
  relayChains,
  requestStatus,
  toUnits,
  type Quote,
  type RelayChain,
  type RelayToken,
  type Step,
  type TrackState,
} from "@/lib/relay";

// ------------------------------------------------------------------ shared bits

function Dot({ label, color }: { label: string; color: string }) {
  return (
    <span className="w-8 h-8 rounded-full flex items-center justify-center text-[0.7rem] font-bold text-white shrink-0" style={{ background: color }} aria-hidden="true">
      {label.replace(/[^A-Za-z]/g, "").slice(0, 3)}
    </span>
  );
}

const TOKEN_COLOR: Record<string, string> = { USDC: "#2775ca", USDT: "#26a17b", USDG: "#0f766e", ETH: "#627eea", SOL: "#8a5cf6", BNB: "#f0b90b", POL: "#8247e5" };

function Picker<T>({
  title,
  items,
  onPick,
  onClose,
}: {
  title: string;
  items: { key: string; label: string; color: string; note?: string; value: T }[];
  onPick: (v: T) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="grid gap-2">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onPick(it.value)}
            className="h-14 px-4 rounded-2xl border border-line flex items-center gap-3 text-left hover:border-emerald"
          >
            <Dot label={it.label} color={it.color} />
            <span className="font-semibold">{it.label}</span>
            {it.note && <span className="ml-auto text-[0.8125rem] text-ink-3">{it.note}</span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Select({ label, color, onClick, ariaLabel }: { label: string; color: string; onClick: () => void; ariaLabel: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className="h-14 w-full rounded-2xl bg-paper border border-line flex items-center gap-3 px-3 text-left hover:border-emerald min-w-0">
      <Dot label={label} color={color} />
      <span className="font-semibold truncate">{label}</span>
      <span className="ml-auto text-ink-3" aria-hidden="true">▾</span>
    </button>
  );
}

function QuoteBox({ quote, label, loading }: { quote: Quote | null; label: string; loading: boolean }) {
  if (loading && !quote) return <div className="mt-4 h-28 rounded-2xl bg-line/50 animate-pulse" />;
  if (!quote) return null;
  const time = quote.seconds <= 10 ? "a few seconds" : quote.seconds < 90 ? `about ${Math.round(quote.seconds / 10) * 10} seconds` : `about ${Math.round(quote.seconds / 60)} minutes`;
  return (
    <div className={"mt-4 rounded-2xl bg-paper border border-line px-4 py-3 text-[0.875rem] " + (loading ? "opacity-60" : "")}>
      <div className="flex justify-between items-baseline gap-3">
        <span className="text-ink-2">{label}</span>
        <span className="font-mono text-[1.125rem]">≈ {fmtAmount(quote.outAmount, quote.outSymbol)}</span>
      </div>
      {quote.outUsd > 0 && (
        <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]">
          <span>Worth about</span>
          <span className="font-mono">{fmtUsd(quote.outUsd)}</span>
        </div>
      )}
      <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]">
        <span>Network &amp; swap cost</span>
        <span className="font-mono">~{fmtUsd(quote.costUsd)}</span>
      </div>
      <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]">
        <span>sasa fee</span>
        <span className="font-bold text-up">$0</span>
      </div>
      <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]">
        <span>Time</span>
        <span>{time}</span>
      </div>
    </div>
  );
}

function Tracker({ steps, at, note }: { steps: [string, string][]; at: number; note?: string }) {
  return (
    <div>
      <ol className="grid gap-1">
        {steps.map(([t, s], i) => (
          <li key={t} className="flex gap-3 items-start py-2">
            <span
              className={
                "w-6 h-6 rounded-full border-2 shrink-0 flex items-center justify-center text-[0.75rem] mt-0.5 " +
                (i < at ? "bg-up border-up text-white" : i === at ? "border-emerald border-t-transparent animate-spin" : "border-line")
              }
              aria-hidden="true"
            >
              {i < at ? "✓" : ""}
            </span>
            <span>
              <span className="block font-semibold">{t}</span>
              <span className="block text-ink-3 text-[0.8125rem]">{s}</span>
            </span>
          </li>
        ))}
      </ol>
      {note && <p className="text-[0.8125rem] text-ink-2 mt-2">{note}</p>}
    </div>
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** The chains sasa lives on that Relay can deliver to (testnet: Base Sepolia only). */
function useSasaChains(relay: RelayChain[] | null): { conf: NeuronChain; relay: RelayChain | null }[] {
  return useMemo(() => {
    const seen = new Set<number>();
    return CHAINS.filter((c) => !seen.has(c.chain.id) && seen.add(c.chain.id)).map((conf) => ({
      conf,
      relay: relay?.find((r) => r.id === conf.chain.id) ?? null,
    }));
  }, [relay]);
}

function useRelayChains() {
  const [chains, setChains] = useState<RelayChain[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    relayChains()
      .then(setChains)
      .catch((e) => setError(friendlyError(e)));
  }, []);
  useEffect(load, [load]);
  return { chains, error, retry: load };
}

// ------------------------------------------------------------------ deposit

type DepositView = "form" | "pickFrom" | "pickToken" | "pickTo" | "address" | "wallet" | "track" | "done";

export function DepositSheet({ onClose }: { onClose: () => void }) {
  const { address, wallets } = useWallet();
  const { chains, error: chainsError, retry } = useRelayChains();
  const sasaChains = useSasaChains(chains);
  const destinations = sasaChains.filter((c) => c.relay);
  const [view, setView] = useState<DepositView>("form");
  const [method, setMethod] = useState<"address" | "wallet">("address");
  const [from, setFrom] = useState<RelayChain | null>(null);
  const [token, setToken] = useState<RelayToken | null>(null);
  const [to, setTo] = useState<RelayChain | null>(null);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [track, setTrack] = useState<{ at: number; result?: { amount: string; usd: number } } | null>(null);
  const injected = wallets.filter((w) => w.id !== WALLETCONNECT_ID && w.provider);

  // Defaults once the chain list arrives.
  const origins = useMemo(() => (chains ?? []).filter((c) => !to || c.id !== to.id), [chains, to]);
  useEffect(() => {
    if (!chains) return;
    if (!to && destinations.length) setTo(destinations[0].relay);
  }, [chains, destinations, to]);
  useEffect(() => {
    if (!from && origins.length) {
      const pick = origins.find((c) => c.name === "Solana") ?? origins[0];
      setFrom(pick);
      setToken(pick.tokens[0]);
    }
  }, [origins, from]);
  useEffect(() => {
    if (from && !from.evm && method === "wallet") setMethod("address");
  }, [from, method]);

  const units = token ? toUnits(amount, token.decimals) : null;
  const dAmount = useDebounced(units, 450);
  useEffect(() => {
    setQuote(null);
    setError("");
    if (!address || !from || !token || !to || !dAmount) return;
    const ctrl = new AbortController();
    setQuoting(true);
    getQuote(
      {
        user: method === "address" ? address : (address as string),
        recipient: address,
        originChainId: from.id,
        originCurrency: token.address,
        destinationChainId: to.id,
        destinationCurrency: to.native.address,
        amount: dAmount,
        useDepositAddress: method === "address" ? true : undefined,
        refundTo: method === "address" ? refundFor(from, address) : undefined,
      },
      ctrl.signal
    )
      .then(setQuote)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(friendlyError(e));
      })
      .finally(() => !ctrl.signal.aborted && setQuoting(false));
    return () => ctrl.abort();
  }, [address, from, token, to, dAmount, method]);

  if (!address) return null;

  if (view === "pickFrom")
    return (
      <Picker
        title="From which chain?"
        items={origins.map((c) => ({ key: String(c.id), label: c.name, color: c.color, value: c }))}
        onPick={(c) => {
          setFrom(c);
          setToken(c.tokens[0]);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );
  if (view === "pickToken" && from)
    return (
      <Picker
        title="Which token?"
        items={from.tokens.map((t) => ({ key: t.symbol, label: t.symbol, color: TOKEN_COLOR[t.symbol] ?? "#666", note: `on ${from.name}`, value: t }))}
        onPick={(t) => {
          setToken(t);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );
  if (view === "pickTo")
    return (
      <Picker
        title="Where should it arrive?"
        items={destinations.map((d) => ({ key: String(d.conf.chain.id), label: d.conf.name, color: d.conf.color, note: "as ETH", value: d.relay as RelayChain }))}
        onPick={(c) => {
          setTo(c);
          if (from && from.id === c.id) setFrom(null);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );

  if (view === "address" && quote?.depositAddress && from && token && to)
    return <DepositAddress onClose={onClose} onBack={() => setView("form")} depositAddress={quote.depositAddress} from={from} token={token} to={to} quote={quote} amount={amount} />;

  if (view === "wallet" && from && token && to && quote)
    return (
      <Sheet title="Deposit" onClose={onClose}>
        <p className="text-ink-2 leading-relaxed">
          Pick the wallet that holds your {token.symbol} on {from.name}. It asks you to confirm, then the money arrives as ETH on {to.name}.
        </p>
        <div className="grid gap-2 mt-4">
          {injected.map((w) => (
            <button
              key={w.id}
              type="button"
              disabled={!!busy}
              onClick={() => void runFromWallet(w)}
              className="h-14 px-4 rounded-2xl border border-line flex items-center gap-3 font-semibold hover:border-emerald disabled:opacity-60"
            >
              {w.icon ? <img src={w.icon} alt="" width={28} height={28} className="w-7 h-7 rounded-lg" /> : <span className="w-7 h-7 rounded-lg bg-line" />}
              {w.name}
            </button>
          ))}
        </div>
        {busy && <p className="text-[0.875rem] text-ink-2 mt-3">{busy}</p>}
        {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
        <button type="button" onClick={() => setView("form")} className="mt-4 text-emerald font-semibold text-[0.875rem]">
          ← Back
        </button>
      </Sheet>
    );

  if ((view === "track" || view === "done") && track && to)
    return (
      <Sheet title="Deposit" onClose={onClose}>
        {view === "done" && track.result ? (
          <div className="text-center py-2">
            <div className="text-[2.5rem]" aria-hidden="true">🎉</div>
            <h3 className="font-display text-[1.25rem] font-semibold mt-1">{fmtAmount(track.result.amount, "ETH")} arrived</h3>
            <p className="text-ink-2 mt-1">{track.result.usd > 0 ? `About ${fmtUsd(track.result.usd)} on ${to.name}. ` : ""}You&apos;re ready to trade.</p>
            <button type="button" onClick={onClose} className="mt-5 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold hover:bg-emerald-dark">
              Start trading
            </button>
          </div>
        ) : (
          <Tracker
            at={track.at}
            steps={[
              [`Sent from ${from?.name ?? "your wallet"}`, `Your ${token?.symbol ?? "money"} left your wallet`],
              [`Moving to ${to.name}`, "Converting to ETH"],
              ["Arrived", "In your sasa wallet"],
            ]}
            note="You can close this. The money arrives either way."
          />
        )}
        {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
      </Sheet>
    );

  async function runFromWallet(w: WalletOption) {
    if (!quote || !from || !w.provider) return;
    setError("");
    try {
      const provider = w.provider;
      setBusy("Connecting…");
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const sender = accounts?.[0];
      if (!sender) throw new Error("Your wallet didn't share an account.");
      // Quote again for this sender (the steps are built for the sending address).
      setBusy("Getting the final price…");
      const q = await getQuote({
        user: sender,
        recipient: address as string,
        originChainId: from.id,
        originCurrency: (token as RelayToken).address,
        destinationChainId: (to as RelayChain).id,
        destinationCurrency: (to as RelayChain).native.address,
        amount: units as string,
      });
      await executeSteps(provider, sender, q.steps, setBusy);
      setBusy("");
      setTrack({ at: 1 });
      setView("track");
      await follow(q.requestId, setTrack, (usd) => setTrack({ at: 3, result: { amount: q.outAmount, usd: usd || q.outUsd } }));
      setView("done");
      toast(`🔔 Deposit arrived: ${fmtAmount(q.outAmount, "ETH")}`);
    } catch (e) {
      setBusy("");
      const code = (e as { code?: number }).code;
      setError(code === 4001 ? "You cancelled it in your wallet." : friendlyError(e));
    }
  }

  // ----- main form
  const tooSoon = !chains && !chainsError;
  return (
    <Sheet title="Deposit" onClose={onClose}>
      {chainsError ? (
        <div>
          <p className="text-danger text-[0.875rem]" role="alert">{chainsError}</p>
          <button type="button" onClick={retry} className="mt-3 h-12 w-full rounded-xl border border-ink font-semibold">Try again</button>
        </div>
      ) : tooSoon ? (
        <div className="h-64 rounded-2xl bg-line/50 animate-pulse" />
      ) : !destinations.length || !origins.length ? (
        <p className="text-ink-2 leading-relaxed">
          Deposits from other chains aren&apos;t available on this network yet. Send ETH straight to your address instead: tap your address at the top to copy it.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1 bg-paper border border-line rounded-2xl p-1" role="group" aria-label="How to deposit">
            {(
              [
                ["address", "Send to an address"],
                ["wallet", "Connect a wallet"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                aria-pressed={method === k}
                disabled={k === "wallet" && (!from?.evm || injected.length === 0)}
                onClick={() => setMethod(k)}
                className={"h-10 rounded-xl text-[0.8125rem] font-semibold disabled:opacity-40 " + (method === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
              >
                {l}
              </button>
            ))}
          </div>
          {method === "address" && (
            <p className="text-[0.8125rem] text-ink-3 mt-2">Works from any wallet or exchange, including {from?.name ?? "other chains"}.</p>
          )}
          {method === "wallet" && <p className="text-[0.8125rem] text-ink-3 mt-2">Use a browser wallet like MetaMask or Rabby.</p>}

          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">From</span>
          <div className="grid grid-cols-2 gap-2">
            {from && <Select label={from.name} color={from.color} onClick={() => setView("pickFrom")} ariaLabel={`From ${from.name}. Change chain`} />}
            {token && <Select label={token.symbol} color={TOKEN_COLOR[token.symbol] ?? "#666"} onClick={() => setView("pickToken")} ariaLabel={`Token ${token.symbol}. Change token`} />}
          </div>
          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">Arrives as ETH on</span>
          {to && <Select label={to.name} color={destinations.find((d) => d.relay?.id === to.id)?.conf.color ?? to.color} onClick={() => setView("pickTo")} ariaLabel={`Arrives on ${to.name}. Change chain`} />}

          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">{method === "address" ? "Roughly how much will you send?" : "Amount"}</span>
          <label className="flex items-center gap-2 h-14 rounded-2xl bg-paper border border-line px-4 focus-within:border-emerald">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-label={`Amount in ${token?.symbol ?? ""}`}
              style={{ outline: "none" }}
              className="flex-1 min-w-0 bg-transparent font-mono text-[1.25rem]"
            />
            <span className="text-ink-3 font-mono">{token?.symbol}</span>
          </label>
          {method === "address" && <p className="text-[0.75rem] text-ink-3 mt-1.5">You can send a different amount later; this just shows the price.</p>}

          <QuoteBox quote={quote} loading={quoting} label="You get" />
          {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}

          <button
            type="button"
            disabled={!quote || quoting || (method === "address" && !quote.depositAddress)}
            onClick={() => setView(method === "address" ? "address" : "wallet")}
            className="mt-4 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-45"
          >
            {method === "address" ? "Show deposit address" : "Choose wallet"}
          </button>
        </>
      )}
    </Sheet>
  );
}

/** Sends every transaction / signature a Relay quote asks for, from an outside wallet. */
async function executeSteps(provider: Eip1193, sender: string, steps: Step[], onStep: (s: string) => void) {
  for (const step of steps) {
    for (const item of step.items) {
      if (item.status === "complete") continue;
      if (step.kind === "transaction") {
        const d = item.data;
        const want = numberToHex(d.chainId);
        const now = (await provider.request({ method: "eth_chainId" })) as string;
        if (now?.toLowerCase() !== want.toLowerCase()) {
          onStep("Switch network in your wallet…");
          try {
            await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
          } catch (e) {
            if ((e as { code?: number }).code === 4902) throw new Error("Add this network to your wallet first, then try again.");
            throw e;
          }
        }
        onStep(step.id === "approve" ? "Allow the token in your wallet…" : "Confirm in your wallet…");
        await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: sender,
              to: d.to,
              data: d.data,
              value: d.value ? numberToHex(BigInt(d.value)) : "0x0",
              ...(typeof d.gas === "string" ? { gas: numberToHex(BigInt(d.gas as string)) } : {}),
            },
          ],
        });
        onStep("Sent. Waiting for the network…");
        if (item.check) await waitCheck(item.check.endpoint);
      } else if (step.kind === "signature") {
        const sign = (item.data as { sign?: { signatureKind: string; message?: string; domain?: unknown; types?: unknown; value?: unknown; primaryType?: string } }).sign;
        const post = (item.data as { post?: { endpoint: string; method: string; body: unknown } }).post;
        if (!sign || !post) continue;
        onStep("Sign in your wallet…");
        let signature: string;
        if (sign.signatureKind === "eip191") {
          signature = (await provider.request({ method: "personal_sign", params: [sign.message, sender] })) as string;
        } else {
          const { EIP712Domain: _drop, ...types } = (sign.types ?? {}) as Record<string, unknown>;
          void _drop;
          signature = (await provider.request({
            method: "eth_signTypedData_v4",
            params: [sender, JSON.stringify({ domain: sign.domain, types, primaryType: sign.primaryType, message: sign.value })],
          })) as string;
        }
        const r = await fetch(`${RELAY_API}${post.endpoint}?signature=${signature}`, {
          method: post.method || "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(post.body),
        });
        if (!r.ok) throw new Error("Relay didn't accept the signature. Try again.");
      }
    }
  }
}

async function waitCheck(endpoint: string) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${RELAY_API}${endpoint}`);
      const j = (await r.json()) as { status?: string };
      const s = (j.status || "").toLowerCase();
      if (["success", "pending", "submitted"].includes(s)) return;
      if (s === "failure" || s === "refund") throw new Error("The transfer failed and will be refunded.");
    } catch (e) {
      if (e instanceof Error && /refund/.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Follows a Relay request to the end; calls onDone when the money has arrived. */
async function follow(
  requestId: string | null,
  set: (t: { at: number }) => void,
  onDone: (usd: number) => void
) {
  if (!requestId) {
    onDone(0);
    return;
  }
  const until = Date.now() + 15 * 60_000;
  let last: TrackState = "waiting";
  while (Date.now() < until) {
    last = await requestStatus(requestId).catch(() => last);
    if (last === "success") {
      onDone(0);
      return;
    }
    if (last === "failure" || last === "refund") throw new Error("The transfer didn't go through. Your money is being sent back.");
    set({ at: last === "pending" ? 1 : 1 });
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("This is taking longer than usual. The money will still arrive; check again in a few minutes.");
}

function DepositAddress({
  depositAddress,
  from,
  token,
  to,
  quote,
  amount,
  onClose,
  onBack,
}: {
  depositAddress: string;
  from: RelayChain;
  token: RelayToken;
  to: RelayChain;
  quote: Quote;
  amount: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState<{ state: TrackState; usd: number } | null>(null);
  const started = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    import("qrcode")
      .then((m) => m.toDataURL(depositAddress, { margin: 1, width: 320, errorCorrectionLevel: "M" }))
      .then((u) => alive && setQr(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [depositAddress]);

  // Watch the address for deposits made after this screen opened.
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await depositsTo(depositAddress);
        const mine = list.find((d) => Date.parse(d.createdAt) >= started.current - 60_000);
        if (mine && alive) {
          setStatus({ state: mine.status, usd: mine.outUsd });
          if (mine.status === "success") {
            toast("🔔 Deposit arrived in your sasa wallet");
            return;
          }
        }
      } catch {}
      if (alive) t = setTimeout(tick, 6000);
    };
    t = setTimeout(tick, 4000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [depositAddress]);

  const copy = () =>
    navigator.clipboard
      ?.writeText(depositAddress)
      .then(() => toast("Address copied"))
      .catch(() => {});

  return (
    <Sheet title={`Send ${token.symbol} to this address`} onClose={onClose}>
      <div className="rounded-2xl bg-paper border border-line p-4 text-center">
        <div className="mx-auto w-44 h-44 bg-white rounded-xl p-2 flex items-center justify-center">
          {qr ? <img src={qr} alt={`QR code of the deposit address ${depositAddress}`} width={160} height={160} /> : <span className="text-black/40 text-sm">QR</span>}
        </div>
        <p className="font-mono text-[0.8125rem] break-all mt-3 leading-relaxed">{depositAddress}</p>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button type="button" onClick={copy} className="h-11 rounded-xl border border-line font-semibold hover:border-emerald">Copy address</button>
          <button
            type="button"
            onClick={() => (navigator.share ? navigator.share({ text: depositAddress }).catch(() => {}) : copy())}
            className="h-11 rounded-xl border border-line font-semibold hover:border-emerald"
          >
            Share
          </button>
        </div>
      </div>
      <div className="mt-3 rounded-2xl bg-warn-bg text-warn-ink px-4 py-3 text-[0.8125rem] leading-relaxed">
        <b className="text-ink">Send only {token.symbol} on {from.name}.</b> Other tokens or networks can be lost. When you withdraw from an exchange, pick the{" "}
        <b className="text-ink">{from.name}</b> network. Very small amounts may be refunded because the network cost would eat them.
      </div>
      <QuoteBox quote={quote} loading={false} label={`If you send ${amount} ${token.symbol}, you get`} />
      <div className="mt-3">
        {status?.state === "success" ? (
          <div className="text-center py-2">
            <div className="text-[2rem]" aria-hidden="true">🎉</div>
            <p className="font-semibold">Your deposit arrived{status.usd > 0 ? ` (about ${fmtUsd(status.usd)})` : ""}.</p>
          </div>
        ) : status?.state === "failure" || status?.state === "refund" ? (
          <p className="text-danger text-[0.875rem]" role="alert">This deposit couldn&apos;t be completed and is being sent back to the sender.</p>
        ) : (
          <Tracker
            at={status ? 1 : 0}
            steps={[
              [status ? "Deposit received" : "Waiting for your deposit…", `Send from your wallet or exchange on ${from.name}`],
              [`Moving to ${to.name}`, "Converting to ETH"],
            ]}
            note="You can close this. The money arrives as ETH in your sasa wallet either way."
          />
        )}
      </div>
      <button type="button" onClick={onBack} className="mt-4 text-emerald font-semibold text-[0.875rem]">
        ← Back
      </button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ withdraw

type WithdrawView = "form" | "pickFrom" | "pickTo" | "pickToken" | "scan" | "review" | "track" | "done";

export function WithdrawSheet({ onClose }: { onClose: () => void }) {
  const { address, embedded, send } = useWallet();
  const { chains } = useRelayChains();
  const sasaChains = useSasaChains(chains);
  const [balances, setBalances] = useState<Record<number, bigint>>({});
  const [origin, setOrigin] = useState<NeuronChain | null>(null);
  const [dest, setDest] = useState<RelayChain | null>(null);
  const [token, setToken] = useState<RelayToken | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [view, setView] = useState<WithdrawView>("form");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [track, setTrack] = useState<{ at: number }>({ at: 0 });
  const [gasReserve, setGasReserve] = useState(0n);

  // Balances on every sasa chain; start from the richest.
  useEffect(() => {
    if (!address) return;
    let alive = true;
    Promise.all(
      sasaChains.map(async ({ conf }) => [conf.chain.id, await cashOf(conf, address as Address)] as const)
    ).then((rows) => {
      if (!alive) return;
      const b = Object.fromEntries(rows) as Record<number, bigint>;
      setBalances(b);
      if (!origin) {
        const best = [...sasaChains].sort((x, y) => (b[y.conf.chain.id] ?? 0n) > (b[x.conf.chain.id] ?? 0n) ? 1 : -1)[0];
        if (best) setOrigin(best.conf);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, sasaChains.length]);

  // Browser wallets pay their own gas: keep a little back when sending "everything".
  useEffect(() => {
    if (!origin || embedded) {
      setGasReserve(0n);
      return;
    }
    clientFor(origin)
      .getGasPrice()
      .then((p) => setGasReserve(p * 250_000n))
      .catch(() => setGasReserve(parseEther("0.0002")));
  }, [origin, embedded]);

  const originRelay = chains?.find((c) => origin && c.id === origin.chain.id) ?? null;
  /** Where money can go from here: the same chain always, other chains if Relay supports this one. */
  const targets = useMemo(() => {
    if (!origin) return [];
    const same: RelayChain = originRelay ?? {
      id: origin.chain.id,
      name: origin.name,
      color: origin.color,
      evm: true,
      tokens: [{ symbol: "ETH", address: NATIVE, decimals: 18 }],
      native: { symbol: "ETH", address: NATIVE, decimals: 18 },
    };
    const others = originRelay ? (chains ?? []).filter((c) => c.id !== origin.chain.id) : [];
    return [same, ...others];
  }, [origin, originRelay, chains]);

  useEffect(() => {
    if (targets.length && (!dest || !targets.some((t) => t.id === dest.id))) {
      setDest(targets[0]);
      setToken(targets[0].native);
    }
  }, [targets, dest]);

  const balance = origin ? balances[origin.chain.id] ?? 0n : 0n;
  const wei = (() => {
    try {
      const v = amount.trim();
      if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return null;
      const w = parseEther(v);
      return w > 0n ? w : null;
    } catch {
      return null;
    }
  })();
  const direct = !!(origin && dest && token && dest.id === origin.chain.id && token.address === NATIVE);
  const addrOk = dest ? (dest.evm ? isEvmAddress(recipient.trim()) : isSolanaAddress(recipient.trim())) : false;
  const addrMsg = (() => {
    const a = recipient.trim();
    if (!a || !dest) return "";
    if (addrOk) return "";
    if (dest.evm && isSolanaAddress(a)) return `That's a Solana address. Pick Solana above, or paste a ${dest.name} address (starts with 0x).`;
    if (!dest.evm && isEvmAddress(a)) return "That's an 0x address. Solana addresses look different; pick another chain or paste a Solana address.";
    return dest.evm ? `That doesn't look like a ${dest.name} address. It starts with 0x and is 42 characters long.` : "That doesn't look like a Solana address.";
  })();
  const over = wei !== null && wei > balance;

  const dWei = useDebounced(wei, 450);
  useEffect(() => {
    setQuote(null);
    setError("");
    if (!address || !origin || !dest || !token || !dWei || direct || dWei > balance) return;
    const ctrl = new AbortController();
    setQuoting(true);
    getQuote(
      {
        user: address,
        recipient: addrOk ? recipient.trim() : dest.evm ? address : "11111111111111111111111111111112",
        originChainId: origin.chain.id,
        originCurrency: NATIVE,
        destinationChainId: dest.id,
        destinationCurrency: token.address,
        amount: dWei.toString(),
      },
      ctrl.signal
    )
      .then(setQuote)
      .catch((e) => !ctrl.signal.aborted && setError(friendlyError(e)))
      .finally(() => !ctrl.signal.aborted && setQuoting(false));
    return () => ctrl.abort();
  }, [address, origin, dest, token, dWei, direct, balance, addrOk, recipient]);

  if (!address) return null;

  if (view === "pickFrom")
    return (
      <Picker
        title="Send from"
        items={sasaChains.map(({ conf }) => ({
          key: conf.key,
          label: conf.name,
          color: conf.color,
          note: `${Number(formatEther(balances[conf.chain.id] ?? 0n)).toFixed(5)} ETH`,
          value: conf,
        }))}
        onPick={(c) => {
          setOrigin(c);
          setDest(null);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );
  if (view === "pickTo")
    return (
      <Picker
        title="Send to which chain?"
        items={targets.map((t, i) => ({ key: String(t.id), label: t.name, color: t.color, note: i === 0 ? "same chain, cheapest" : "", value: t }))}
        onPick={(t) => {
          setDest(t);
          setToken(t.tokens.find((x) => x.symbol === token?.symbol) ?? t.tokens.find((x) => x.symbol === "USDC") ?? t.native);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );
  if (view === "pickToken" && dest)
    return (
      <Picker
        title="Receive as"
        items={(origin && dest.id === origin.chain.id && !originRelay ? [dest.native] : dest.tokens).map((t) => ({
          key: t.symbol,
          label: t.symbol,
          color: TOKEN_COLOR[t.symbol] ?? "#666",
          note: `on ${dest.name}`,
          value: t,
        }))}
        onPick={(t) => {
          setToken(t);
          setView("form");
        }}
        onClose={() => setView("form")}
      />
    );
  if (view === "scan")
    return (
      <QrScanner
        onClose={() => setView("form")}
        onResult={(text) => {
          setRecipient(addressFromQr(text));
          toast("Address scanned");
          setView("form");
        }}
      />
    );

  const receive = direct ? { amount: amount, symbol: "ETH", usd: 0 } : quote ? { amount: quote.outAmount, symbol: quote.outSymbol || token?.symbol || "", usd: quote.outUsd } : null;

  if (view === "review" && origin && dest && token && wei && receive)
    return (
      <Sheet title="Check and send" onClose={onClose}>
        <dl className="rounded-2xl bg-paper border border-line px-4 text-[0.875rem]">
          {(
            [
              ["You send", fmtAmount(formatEther(wei), "ETH")],
              ["They receive", `≈ ${fmtAmount(receive.amount, receive.symbol)}`],
              ["On", dest.name],
              ["To", recipient.trim()],
              ["Network & swap cost", direct ? (embedded ? "$0 (we pay it)" : "network gas") : `~${fmtUsd(quote?.costUsd ?? 0)}`],
              ["sasa fee", "$0"],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2.5 border-t border-line first:border-t-0">
              <dt className="text-ink-3">{k}</dt>
              <dd className={"text-right break-all " + (k === "To" ? "font-mono text-[0.8rem]" : k === "sasa fee" ? "text-up font-bold" : "font-mono")}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 rounded-2xl bg-warn-bg text-warn-ink px-4 py-3 text-[0.8125rem] leading-relaxed">
          <b className="text-ink">Double-check the address.</b> Crypto sent to a wrong address can&apos;t be brought back.
        </div>
        {busy && <p className="text-[0.875rem] text-ink-2 mt-3">{busy}</p>}
        {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void doSend()}
          className="mt-4 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-60"
        >
          {busy ? "Sending…" : "Withdraw"}
        </button>
        <button type="button" onClick={() => setView("form")} className="mt-3 text-emerald font-semibold text-[0.875rem]">
          ← Back
        </button>
      </Sheet>
    );

  if ((view === "track" || view === "done") && dest && token)
    return (
      <Sheet title="Withdraw" onClose={onClose}>
        {view === "done" ? (
          <div className="text-center py-2">
            <div className="text-[2.5rem]" aria-hidden="true">✅</div>
            <h3 className="font-display text-[1.25rem] font-semibold mt-1">{receive ? `${fmtAmount(receive.amount, receive.symbol)} delivered` : "Delivered"}</h3>
            <p className="text-ink-2 mt-1">
              Sent to <span className="font-mono">{recipient.trim().slice(0, 6)}…{recipient.trim().slice(-4)}</span> on {dest.name}.
            </p>
            <button type="button" onClick={onClose} className="mt-5 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold hover:bg-emerald-dark">
              Done
            </button>
          </div>
        ) : (
          <Tracker
            at={track.at}
            steps={
              direct
                ? [
                    ["Sending", `On ${dest.name}`],
                    ["Sent", "It's in the other wallet"],
                  ]
                : [
                    ["Leaving your sasa wallet", `From ${origin?.name ?? ""}`],
                    [`Moving to ${dest.name}`, `Converting to ${token.symbol}`],
                    ["Delivered", "In the other wallet"],
                  ]
            }
            note="You can close this. The transfer finishes either way."
          />
        )}
        {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
      </Sheet>
    );

  async function doSend() {
    if (!origin || !dest || !token || !wei) return;
    setError("");
    setBusy("Starting…");
    try {
      if (direct) {
        await send(origin.chain, [{ to: recipient.trim() as Address, data: "0x" as Hex, value: wei }], setBusy);
        setBusy("");
        setTrack({ at: 2 });
        setView("done");
        toast("🔔 Withdrawal sent");
        return;
      }
      // Fresh quote with the real recipient, then run its transactions from the sasa wallet.
      const q = await getQuote({
        user: address as string,
        recipient: recipient.trim(),
        originChainId: origin.chain.id,
        originCurrency: NATIVE,
        destinationChainId: dest.id,
        destinationCurrency: token.address,
        amount: wei.toString(),
      });
      const calls = q.steps
        .filter((s) => s.kind === "transaction")
        .flatMap((s) => s.items)
        .map((it) => {
          if (it.data.chainId !== origin.chain.id) throw new Error("This route needs a step on another chain. Pick a different token or chain.");
          return { to: it.data.to as Address, data: (it.data.data || "0x") as Hex, value: it.data.value ? BigInt(it.data.value) : 0n };
        });
      if (!calls.length) throw new Error("Couldn't prepare the transfer. Try again.");
      setQuote(q);
      await send(origin.chain, calls, setBusy);
      setBusy("");
      setTrack({ at: 1 });
      setView("track");
      await follow(q.requestId, setTrack, () => setTrack({ at: 3 }));
      setView("done");
      toast("🔔 Withdrawal delivered");
    } catch (e) {
      setBusy("");
      const code = (e as { code?: number }).code;
      setError(code === 4001 ? "You cancelled it in your wallet." : friendlyError(e));
    }
  }

  const max = balance > gasReserve ? balance - gasReserve : 0n;
  return (
    <Sheet title="Withdraw" onClose={onClose}>
      {!origin ? (
        <div className="h-64 rounded-2xl bg-line/50 animate-pulse" />
      ) : (
        <>
          {sasaChains.length > 1 && (
            <>
              <span className="block text-[0.8125rem] font-semibold text-ink-3 mb-1.5">Send from</span>
              <Select label={origin.name} color={origin.color} onClick={() => setView("pickFrom")} ariaLabel={`Send from ${origin.name}. Change`} />
            </>
          )}
          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">Send to</span>
          <div className="grid grid-cols-2 gap-2">
            {dest && <Select label={dest.name} color={dest.color} onClick={() => setView("pickTo")} ariaLabel={`Send to ${dest.name}. Change chain`} />}
            {token && <Select label={token.symbol} color={TOKEN_COLOR[token.symbol] ?? "#666"} onClick={() => setView("pickToken")} ariaLabel={`Receive as ${token.symbol}. Change`} />}
          </div>
          {!originRelay && chains && (
            <p className="text-[0.75rem] text-ink-3 mt-1.5">From {origin.name} you can send ETH on the same chain. Other chains open up on mainnet.</p>
          )}

          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">Address</span>
          <div className="flex items-center gap-1.5 min-h-14 rounded-2xl bg-paper border border-line pl-3 pr-1.5 py-1.5 focus-within:border-emerald">
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={dest?.evm === false ? "Solana address" : "0x…"}
              aria-label="Recipient address"
              style={{ outline: "none" }}
              className="flex-1 min-w-0 bg-transparent font-mono text-[0.875rem]"
            />
            <button
              type="button"
              onClick={() =>
                navigator.clipboard
                  ?.readText()
                  .then((t) => setRecipient(addressFromQr(t)))
                  .catch(() => toast("Allow pasting, or long-press the box and paste"))
              }
              className="h-10 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold hover:border-emerald"
            >
              Paste
            </button>
            <button type="button" onClick={() => setView("scan")} aria-label="Scan a QR code" className="h-10 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold hover:border-emerald">
              ⌗ Scan
            </button>
          </div>
          {addrMsg && <p className="text-[0.8125rem] text-danger mt-1.5" role="alert">{addrMsg}</p>}

          <span className="block text-[0.8125rem] font-semibold text-ink-3 mt-4 mb-1.5">Amount</span>
          <label className="flex items-center gap-2 h-14 rounded-2xl bg-paper border border-line px-4 focus-within:border-emerald">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-label="Amount in ETH"
              style={{ outline: "none" }}
              className="flex-1 min-w-0 bg-transparent font-mono text-[1.25rem]"
            />
            <span className="text-ink-3 font-mono">ETH</span>
          </label>
          <div className="flex justify-between text-[0.8125rem] text-ink-3 mt-1.5">
            <span>Available: {Number(formatEther(balance)).toFixed(5)} ETH</span>
            <button type="button" onClick={() => setAmount(formatEther(max))} disabled={max === 0n} className="text-emerald font-bold disabled:opacity-40">
              Max
            </button>
          </div>
          {over && <p className="text-[0.8125rem] text-danger mt-1.5" role="alert">That&apos;s more than you have. Tap Max to send everything.</p>}

          {direct ? (
            wei && !over ? (
              <div className="mt-4 rounded-2xl bg-paper border border-line px-4 py-3 text-[0.875rem]">
                <div className="flex justify-between gap-3"><span className="text-ink-2">They receive</span><span className="font-mono text-[1.125rem]">{fmtAmount(amount, "ETH")}</span></div>
                <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]"><span>Network cost</span><span>{embedded ? "$0 (we pay it)" : "a little gas"}</span></div>
                <div className="flex justify-between mt-1.5 text-ink-2 text-[0.8125rem]"><span>sasa fee</span><span className="font-bold text-up">$0</span></div>
              </div>
            ) : null
          ) : (
            <QuoteBox quote={quote} loading={quoting} label="They receive" />
          )}
          {error && <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>}
          {dest && origin && dest.id !== origin.chain.id && (
            <div className="mt-3 rounded-2xl bg-warn-bg text-warn-ink px-4 py-3 text-[0.8125rem] leading-relaxed">
              Sending to an exchange? On its deposit page, pick the <b className="text-ink">{dest.name}</b> network and <b className="text-ink">{token?.symbol}</b>.
            </div>
          )}
          <button
            type="button"
            disabled={!addrOk || !wei || over || (!direct && (!quote || quoting))}
            onClick={() => setView("review")}
            className="mt-4 h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-45"
          >
            Review
          </button>
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ QR scanner

type Detector = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };

function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return;
        const v = video.current as HTMLVideoElement;
        v.srcObject = stream;
        await v.play();
        const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        let detector: Detector | null = null;
        if (BD) {
          try {
            detector = new BD({ formats: ["qr_code"] });
          } catch {
            detector = null;
          }
        }
        const jsQR = detector ? null : (await import("jsqr")).default;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const scan = async () => {
          if (stopped || done.current) return;
          if (v.readyState >= 2) {
            try {
              let text = "";
              if (detector) {
                const found = await detector.detect(v);
                text = found[0]?.rawValue ?? "";
              } else if (jsQR && ctx) {
                const w = Math.min(640, v.videoWidth);
                const h = Math.round((v.videoHeight / v.videoWidth) * w);
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(v, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                text = jsQR(img.data, w, h)?.data ?? "";
              }
              if (text) {
                done.current = true;
                onResult(text);
                return;
              }
            } catch {}
          }
          raf = requestAnimationFrame(() => void scan());
        };
        void scan();
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow the camera for this site, or paste the address instead."
            : "Couldn't open the camera on this device. Paste the address instead."
        );
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <Sheet title="Scan QR code" onClose={onClose}>
      <div className="relative h-72 rounded-2xl bg-black overflow-hidden flex items-center justify-center">
        <video ref={video} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        <div className="relative w-44 h-44 rounded-2xl border-[3px] border-white shadow-[0_0_0_999px_rgba(0,0,0,0.45)]" aria-hidden="true" />
      </div>
      {error ? (
        <p className="text-[0.875rem] text-danger mt-3" role="alert">{error}</p>
      ) : (
        <p className="text-[0.8125rem] text-ink-2 mt-3 text-center">Point your camera at the address QR code, for example on your exchange&apos;s deposit page.</p>
      )}
      <button type="button" onClick={onClose} className="mt-4 text-emerald font-semibold text-[0.875rem]">
        ← Back
      </button>
    </Sheet>
  );
}
