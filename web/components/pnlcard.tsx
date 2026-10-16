"use client";

/**
 * The PnL card: a picture of a futures position's result (coin, side, leverage, ROI) to share
 * on X or anywhere. Drawn on a canvas in the browser; nothing is uploaded.
 */
import { useEffect, useState } from "react";
import { Sheet } from "./chrome";

export type PnlCardData = { coin: string; side: "long" | "short"; lev: number; roi: number; pnl: number; entry: string; mark: string };

const W = 1200;
const H = 630;

/** A rounded rectangle path (roundRect is missing on older Safari). */
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

async function img(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}

/** Draws the card; returns the canvas. */
export async function drawPnlCard(d: PnlCardData, showUsd: boolean): Promise<HTMLCanvasElement> {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  try {
    await Promise.all([document.fonts.load("800 64px Sora"), document.fonts.load("600 28px Sora"), document.fonts.load("500 28px 'Instrument Sans'")]);
  } catch {}
  const win = d.roi >= 0;
  const accent = win ? "#22c55e" : "#ef4444";

  // background: deep night with a warm glow and a soft glow in the result's colour
  g.fillStyle = "#0c0b10";
  g.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, col: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  };
  glow(1050, 80, 520, "rgba(255,107,26,0.30)");
  glow(260, 560, 520, win ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)");
  // fine grid
  g.strokeStyle = "rgba(255,255,255,0.04)";
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(W, y + 0.5);
    g.stroke();
  }
  // a rising (or falling) line across the back
  g.save();
  g.beginPath();
  const pts = 60;
  for (let i = 0; i <= pts; i++) {
    const x = 520 + (i / pts) * 680;
    const t = i / pts;
    const wave = Math.sin(i * 0.9) * 14 + Math.sin(i * 0.31) * 22;
    const y = win ? 520 - t * 330 + wave : 190 + t * 330 + wave;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.strokeStyle = accent;
  g.globalAlpha = 0.55;
  g.lineWidth = 5;
  g.lineJoin = "round";
  g.shadowColor = accent;
  g.shadowBlur = 24;
  g.stroke();
  g.restore();

  // logo + wordmark (brand gradient, never plain white)
  const logo = await img("/sasa-icon-512.png");
  if (logo) {
    g.save();
    const r = 18;
    rr(g, 64, 56, 64, 64, r);
    g.clip();
    g.drawImage(logo, 64, 56, 64, 64);
    g.restore();
  }
  const brand = g.createLinearGradient(146, 0, 290, 0);
  brand.addColorStop(0, "#ffb31a");
  brand.addColorStop(1, "#ff5a1a");
  g.fillStyle = brand;
  g.font = "800 50px Sora, sans-serif";
  g.textBaseline = "middle";
  g.fillText("sasa", 146, 90);
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.font = "600 24px Sora, sans-serif";
  g.textAlign = "right";
  g.fillText("FUTURES", W - 64, 90);
  g.textAlign = "left";

  // coin + side pill
  g.fillStyle = "#ffffff";
  g.font = "800 64px Sora, sans-serif";
  g.textBaseline = "alphabetic";
  g.fillText(`${d.coin}`, 64, 232);
  const cw = g.measureText(d.coin).width;
  const label = `${d.side === "long" ? "LONG" : "SHORT"} ${d.lev}x`;
  g.font = "700 26px Sora, sans-serif";
  const lw = g.measureText(label).width + 36;
  g.fillStyle = d.side === "long" ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.16)";
  rr(g, 64 + cw + 24, 190, lw, 50, 25);
  g.fill();
  g.fillStyle = d.side === "long" ? "#4ade80" : "#f87171";
  g.fillText(label, 64 + cw + 42, 225);

  // the result
  const roi = `${d.roi >= 0 ? "+" : "−"}${Math.abs(d.roi).toFixed(2)}%`;
  g.font = "800 150px Sora, sans-serif";
  const rg = g.createLinearGradient(64, 280, 64, 420);
  rg.addColorStop(0, win ? "#86efac" : "#fca5a5");
  rg.addColorStop(1, accent);
  g.fillStyle = rg;
  g.fillText(roi, 58, 410);
  g.fillStyle = "rgba(255,255,255,0.6)";
  g.font = "500 28px 'Instrument Sans', sans-serif";
  g.fillText(showUsd ? `ROI  ·  PnL ${d.pnl >= 0 ? "+" : "−"}$${Math.abs(d.pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "ROI", 66, 456);

  // entry / now
  const row = (x: number, k: string, v: string) => {
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.font = "500 22px 'Instrument Sans', sans-serif";
    g.fillText(k, x, 530);
    g.fillStyle = "#ffffff";
    g.font = "600 30px Sora, sans-serif";
    g.fillText(v, x, 568);
  };
  row(66, "Entry", d.entry);
  row(330, "Now", d.mark);
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.font = "600 24px Sora, sans-serif";
  g.textAlign = "right";
  g.fillText("sasapad.fun", W - 64, 568);
  g.textAlign = "left";
  return c;
}

export function PnlCardSheet({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const [showUsd, setShowUsd] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const key = JSON.stringify(data);
  useEffect(() => {
    let alive = true;
    void drawPnlCard(JSON.parse(key) as PnlCardData, showUsd)
      .then((c) => {
        if (alive) setUrl(c.toDataURL("image/png"));
      })
      .catch(() => alive && setNote("This browser couldn't draw the picture."));
    return () => {
      alive = false;
    };
  }, [key, showUsd]);
  // the file is made from the picture on screen, so what is shared is what is shown
  const file = async () => {
    if (!url) return null;
    const b = await (await fetch(url)).blob();
    return new File([b], `sasa-${data.coin}-${data.side}.png`, { type: "image/png" });
  };
  const text = `${data.coin} ${data.side} ${data.lev}x ${data.roi >= 0 ? "+" : "−"}${Math.abs(data.roi).toFixed(2)}% on sasa`;
  const share = async () => {
    const f = await file().catch(() => null);
    try {
      if (f && navigator.canShare?.({ files: [f] })) {
        await navigator.share({ files: [f], text: `${text}\nsasapad.fun` });
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // closed by the user
    }
    download();
    setNote("Saved. Attach the picture to your post.");
  };
  const download = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `sasa-${data.coin}-${data.side}.png`;
    a.click();
  };
  const toX = () => {
    download();
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${text}\n\nsasapad.fun`)}`, "_blank", "noopener,noreferrer");
    setNote("The picture is saved: attach it to your post on X.");
  };
  return (
    <Sheet title="Share your result" onClose={onClose}>
      <div className="flex flex-col gap-3 pb-2">
        <div className="rounded-2xl overflow-hidden border border-line bg-night aspect-[1200/630]">
          {url ? <img src={url} alt={text} className="w-full h-full object-cover" /> : <div className="w-full h-full shimmer" />}
        </div>
        <label className="flex items-center gap-2 text-[0.875rem] cursor-pointer select-none">
          <input type="checkbox" checked={showUsd} onChange={(e) => setShowUsd(e.target.checked)} className="w-4 h-4 accent-[var(--color-emerald)]" />
          Show the profit in dollars
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={toX} disabled={!url} className="h-12 rounded-full bg-ink text-paper font-bold disabled:opacity-50">
            Post on X
          </button>
          <button type="button" onClick={() => void share()} disabled={!url} className="h-12 rounded-full border border-line font-bold disabled:opacity-50">
            Share or save
          </button>
        </div>
        {note && <p className="text-[0.8125rem] text-ink-3 text-center">{note}</p>}
      </div>
    </Sheet>
  );
}
