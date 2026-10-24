/**
 * The Solana libraries (lib/sollaunch.ts) expect Node's `Buffer` to exist in the browser.
 * Imported first by the files that need it, so it is there before they load.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

export {};
