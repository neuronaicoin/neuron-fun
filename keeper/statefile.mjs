/**
 * The keepers' scan progress file. Written to a temporary file and renamed, so a restart in
 * the middle never leaves half a file. One that can't be read (whatever the reason) starts over
 * from the deployment start blocks, which is safe: every step is checked on chain before it is
 * sent, so nothing is ever done twice.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function readState(file, log = console.log) {
  if (!existsSync(file)) return { cursor: {}, coins: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s && typeof s === "object" && s.cursor && typeof s.cursor === "object" && s.coins && typeof s.coins === "object") return s;
    throw new Error("missing fields");
  } catch (e) {
    log(`state file ${file} can't be read (${e.message}): starting over from the start blocks`);
    return { cursor: {}, coins: {} };
  }
}

export function writeState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${file}.tmp`, file);
}
