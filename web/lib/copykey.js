// The copy-trading keys at rest: AES-GCM with a key made from COPY_KEY_SECRET (SHA-256).
// Stored as base64(iv | ciphertext). The same code runs on Cloudflare (edge/copy-api.js) and in
// the indexer (indexer/copykey.mjs is a copy of this file): keep the two the same.

const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error("COPY_KEY_SECRET is missing or too short (16+ characters).");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(String(secret)));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptKey(privateKey, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(privateKey)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function decryptKey(stored, secret) {
  const all = unb64(stored);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(secret), all.slice(12));
  return dec.decode(pt);
}
