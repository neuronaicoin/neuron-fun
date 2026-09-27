/**
 * Draws a 1200×630 profit card in the browser (no server involved).
 * Used after a profitable sell so people can post it.
 */
export type ProfitInfo = {
  name: string;
  symbol: string;
  logo: string;
  pct: number; // 0.25 = +25%
  profit: string; // formatted, e.g. "+$12.30"
  cost: string;
  proceeds: string;
  chain: string;
  testnet: boolean;
};

function mark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const k = s / 100;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#1A130D";
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, 24 * k);
  ctx.fill();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 11 * k;
  ctx.strokeStyle = "#FFB020";
  ctx.beginPath();
  ctx.moveTo(26 * k, 60 * k);
  ctx.lineTo(50 * k, 38 * k);
  ctx.lineTo(74 * k, 60 * k);
  ctx.stroke();
  ctx.strokeStyle = "#FF6B1A";
  ctx.beginPath();
  ctx.moveTo(26 * k, 80 * k);
  ctx.lineTo(50 * k, 58 * k);
  ctx.lineTo(74 * k, 80 * k);
  ctx.stroke();
  ctx.fillStyle = "#FFB020";
  ctx.beginPath();
  ctx.arc(50 * k, 22 * k, 6 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    if (!/^data:image\//.test(src)) return res(null);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

export async function drawProfitCard(p: ProfitInfo): Promise<Blob> {
  const W = 1200;
  const H = 630;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  try {
    await Promise.all([document.fonts.load('700 100px "Sora"'), document.fonts.load('400 24px "IBM Plex Mono"')]);
  } catch {}
  const display = '"Sora", ui-sans-serif, system-ui, sans-serif';
  const mono = '"IBM Plex Mono", ui-monospace, monospace';

  // Background with a warm glow and a fine grid
  ctx.fillStyle = "#0B0806";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.35, 20, W * 0.78, H * 0.35, 620);
  glow.addColorStop(0, "rgba(47,211,155,0.30)");
  glow.addColorStop(1, "rgba(47,211,155,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,244,236,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  // Brand
  mark(ctx, 70, 58, 52);
  ctx.fillStyle = "#FFF4EC";
  ctx.font = `700 32px ${display}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("sasa", 136, 96);
  if (p.testnet) {
    ctx.font = `400 18px ${mono}`;
    ctx.fillStyle = "#8F7F73";
    ctx.textAlign = "right";
    ctx.fillText("TESTNET", W - 70, 92);
    ctx.textAlign = "left";
  }

  // Coin
  const img = await loadImage(p.logo);
  const ax = 70;
  const ay = 170;
  const as = 96;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ax, ay, as, as, 24);
  ctx.clip();
  if (img) ctx.drawImage(img, ax, ay, as, as);
  else {
    const g = ctx.createLinearGradient(ax, ay, ax + as, ay + as);
    g.addColorStop(0, "#FF8A3D");
    g.addColorStop(1, "#8A2E07");
    ctx.fillStyle = g;
    ctx.fillRect(ax, ay, as, as);
    ctx.fillStyle = "#FFF4EC";
    ctx.font = `700 40px ${display}`;
    ctx.textAlign = "center";
    ctx.fillText(p.symbol.slice(0, 2).toUpperCase(), ax + as / 2, ay + as / 2 + 14);
    ctx.textAlign = "left";
  }
  ctx.restore();
  ctx.fillStyle = "#FFF4EC";
  ctx.font = `700 44px ${display}`;
  ctx.fillText(`$${p.symbol}`.slice(0, 14), 190, 212);
  ctx.fillStyle = "#A8978A";
  ctx.font = `400 24px ${mono}`;
  ctx.fillText(`${p.name}`.slice(0, 28) + `  ·  ${p.chain}`, 192, 250);

  // The number
  const pctText = `+${(p.pct * 100).toFixed(p.pct >= 10 ? 0 : 1)}%`;
  let size = 190;
  ctx.font = `700 ${size}px ${display}`;
  while (ctx.measureText(pctText).width > 1060 && size > 80) {
    size -= 10;
    ctx.font = `700 ${size}px ${display}`;
  }
  ctx.fillStyle = "#2FD39B";
  ctx.fillText(pctText, 62, 460);

  // Details
  ctx.font = `700 34px ${display}`;
  ctx.fillStyle = "#FFF4EC";
  ctx.fillText(`Profit ${p.profit}`, 70, 520);
  ctx.font = `400 22px ${mono}`;
  ctx.fillStyle = "#8F7F73";
  ctx.fillText(`Cost ${p.cost}   →   Sold ${p.proceeds}`, 72, 560);

  // Footer
  ctx.font = `600 22px ${display}`;
  ctx.fillStyle = "#8F7F73";
  ctx.textAlign = "right";
  ctx.fillText("Launch once. Live on every chain.", W - 70, 560);
  ctx.fillStyle = "#FF6B1A";
  ctx.font = `400 22px ${mono}`;
  ctx.fillText("sasapad.fun", W - 70, 594);
  ctx.textAlign = "left";

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not draw the card."))), "image/png"));
}
