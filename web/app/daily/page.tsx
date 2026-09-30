"use client";

/**
 * Daily X post maker: today's top gainers on a chain, as ready-to-post text
 * (tagging up to 3 projects) and a matching image to attach.
 */
import { useEffect, useRef, useState } from "react";
import { EXT_NETWORKS, fetchExtCoins, type ExtCoin } from "@/lib/extcoins";
import { postOnX } from "@/components/share";
import { toast } from "@/components/alerts";
import { IS_TESTNET } from "@/lib/config";

const MIN_VOL = 25_000; // skip thin coins: a daily post should show real movers

const CHAIN_NAME: Record<string, string> = { robinhood: "Robinhood Chain", base: "Base", bsc: "BNB Chain", arc: "Arc", eth: "Ethereum" };
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;

export default function DailyPage() {
  const [net, setNet] = useState("robinhood");
  const [list, setList] = useState<ExtCoin[] | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setList(null);
    fetchExtCoins("gainers", net, "", 40)
      .then((l) => setList(l.filter((c) => (c.vol24h ?? 0) >= MIN_VOL && (c.change24h ?? 0) > 0).slice(0, 5)))
      .catch(() => setList([]));
  }, [net]);

  const chain = CHAIN_NAME[net];
  const tags = (list ?? []).map((c) => c.xHandle).filter(Boolean).slice(0, 3) as string[];
  const text = list?.length
    ? `🔥 Top gainers on ${chain} today\n\n${list.map((c, i) => `${i + 1}. $${c.symbol} ${pct(c.change24h ?? 0)}`).join("\n")}\n\n${IS_TESTNET ? "Soon on sasa: trade them in USDC in one tap 👀" : "Trade them in USDC in one tap on sasa 👇"}${tags.length ? `\n\n${tags.map((t) => "@" + t).join(" ")}` : ""}`
    : "";

  // The image: same list, drawn in sasa's colors (1200 x 675, X's preferred size).
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !list?.length) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const W = 1200, H = 675;
    cv.width = W;
    cv.height = H;
    g.fillStyle = "#0b0806";
    g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.85, H * 0.2, 10, W * 0.85, H * 0.2, 520);
    glow.addColorStop(0, "rgba(255,107,26,0.30)");
    glow.addColorStop(1, "rgba(255,107,26,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    const color = EXT_NETWORKS.find((n) => n.id === net)?.color ?? "#ff6b1a";
    g.fillStyle = "#ff6b1a";
    g.font = "600 22px 'IBM Plex Mono', monospace";
    g.fillText("TOP GAINERS TODAY", 70, 92);
    g.fillStyle = "#fff4ec";
    g.font = "800 58px Sora, system-ui, sans-serif";
    g.fillText(`on ${chain}`, 70, 160);
    list.forEach((c, i) => {
      const y = 232 + i * 72;
      g.fillStyle = "rgba(255,255,255,0.05)";
      g.beginPath();
      g.roundRect(70, y - 44, W - 140, 60, 18);
      g.fill();
      g.fillStyle = "#8f7f73";
      g.font = "700 26px 'IBM Plex Mono', monospace";
      g.fillText(`${i + 1}`, 96, y - 4);
      g.fillStyle = color;
      g.beginPath();
      g.arc(160, y - 14, 12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff4ec";
      g.font = "700 30px Sora, system-ui, sans-serif";
      g.fillText(`$${c.symbol}`.slice(0, 18), 190, y - 3);
      g.fillStyle = "#2fd39b";
      g.font = "700 30px 'IBM Plex Mono', monospace";
      const t = pct(c.change24h ?? 0);
      g.fillText(t, W - 100 - g.measureText(t).width, y - 3);
    });
    g.fillStyle = "#cdbbae";
    g.font = "500 24px 'Instrument Sans', system-ui, sans-serif";
    g.fillText(IS_TESTNET ? "Testnet live · mainnet soon" : "Trade any coin in USDC, in one tap", 70, H - 50);
    g.fillStyle = "#ff6b1a";
    g.font = "700 26px Sora, system-ui, sans-serif";
    const site = "sasapad.fun";
    g.fillText(site, W - 70 - g.measureText(site).width, H - 50);
  }, [list, net, chain]);

  const download = () => {
    const cv = canvas.current;
    if (!cv) return;
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `sasa-top-gainers-${net}.png`;
    a.click();
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-28 md:pb-12">
      <h1 className="font-display font-bold text-[1.75rem]">Daily post</h1>
      <p className="text-ink-2 mt-1">Today’s top gainers, ready to post. Download the image, then tap “Post on X” and attach it.</p>
      <div className="mt-4 flex gap-1.5 overflow-x-auto [scrollbar-width:none]" role="group" aria-label="Chain">
        {EXT_NETWORKS.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-pressed={net === n.id}
            onClick={() => setNet(n.id)}
            className={"shrink-0 h-9 px-3 rounded-xl border text-[0.8125rem] font-semibold flex items-center gap-2 " + (net === n.id ? "border-emerald text-ink bg-emerald-soft" : "border-line text-ink-2")}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: n.color }} aria-hidden="true" />
            {n.label}
          </button>
        ))}
      </div>
      {list === null ? (
        <div className="shimmer h-64 rounded-3xl mt-4" />
      ) : list.length === 0 ? (
        <p className="mt-6 text-ink-3">No coins on this chain gained with enough volume today. Try another chain.</p>
      ) : (
        <>
          <canvas ref={canvas} className="mt-4 w-full rounded-2xl border border-line" style={{ aspectRatio: "1200 / 675" }} />
          <pre className="mt-4 whitespace-pre-wrap rounded-2xl border border-line bg-surface p-4 text-[0.875rem] font-sans">{text}</pre>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button type="button" onClick={download} className="h-12 rounded-xl border border-line font-semibold">
              Download image
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(text).then(() => toast("Text copied"), () => {})}
              className="h-12 rounded-xl border border-line font-semibold"
            >
              Copy text
            </button>
            <button type="button" onClick={() => postOnX(text, "https://sasapad.fun/explore/")} className="h-12 rounded-xl bg-emerald text-on-accent font-bold">
              Post on X
            </button>
          </div>
          <p className="text-[0.75rem] text-ink-3 mt-3">Tags at most 3 projects so the post doesn’t look like spam. Post once or twice a day.</p>
        </>
      )}
    </div>
  );
}
