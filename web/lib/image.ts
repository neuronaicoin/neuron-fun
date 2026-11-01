/**
 * Turns a picture the user picked into a small square JPEG data URL that can
 * be stored with the coin itself, so no image hosting is needed.
 * Center-crops to a square, scales to 128x128, and lowers the quality until
 * it fits the size budget.
 */
const SIZE = 128;
const MAX_BYTES = 9_000;

/**
 * An animated GIF can't be squeezed into the coin's own small picture: it's uploaded to sasa
 * (/api/gif, kept as it is, up to 2 MB) and the coin points to its address, so it moves everywhere.
 */
export async function uploadGif(file: File): Promise<string> {
  if (file.size > 2_000_000) throw new Error("That GIF is over 2 MB. Try a smaller one (around 200×200 works well).");
  const r = await fetch("/api/gif", { method: "POST", headers: { "content-type": "image/gif" }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.url !== "string") throw new Error(j.error || "Couldn't upload the GIF. Try again.");
  return j.url;
}
const gifUrls = new WeakMap<File, Promise<string>>();
const gifOnce = (file: File) => { let p = gifUrls.get(file); if (!p) { p = uploadGif(file); gifUrls.set(file, p); } return p; };

export async function fileToLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please pick an image file.");
  if (file.type === "image/gif") return gifOnce(file);
  if (file.size > 15 * 1024 * 1024) throw new Error("That picture is too big. Pick one under 15 MB.");

  const bitmap = await loadImage(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not process the picture.");
  // JPEG has no transparency; give transparent logos a white background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);

  for (const q of [0.85, 0.75, 0.65, 0.55, 0.45, 0.35]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= MAX_BYTES) return url;
  }
  throw new Error("Could not make that picture small enough. Try a simpler image.");
}

/**
 * The same picture at 512x512 (JPEG, under ~250 KB) for Solana launches: Solana apps show the
 * coin's picture larger than sasa does, from a file stored with the coin's info.
 */
export async function fileToBigLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please pick an image file.");
  if (file.type === "image/gif") return gifOnce(file);
  const BIG = 512;
  const bitmap = await loadImage(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(BIG, side);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not process the picture.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= 330_000) return url;
  }
  throw new Error("Could not make that picture small enough. Try a simpler image.");
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be opened as a picture."));
    };
    img.src = url;
  });
}
