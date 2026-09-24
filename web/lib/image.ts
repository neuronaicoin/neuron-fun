/**
 * Turns a picture the user picked into a small square JPEG data URL that can
 * be stored with the coin itself, so no image hosting is needed.
 * Center-crops to a square, scales to 128x128, and lowers the quality until
 * it fits the size budget.
 */
const SIZE = 128;
const MAX_BYTES = 9_000;

export async function fileToLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please pick an image file.");
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
