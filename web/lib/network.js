/**
 * Which network the whole site runs on: the pages (lib/config.ts) and the edge scripts
 * (forum, sitemaps, llms files) all read it from here. Switch day: set it to "mainnet" (after
 * the mainnet contracts are deployed and lib/mainnet.json and lib/race.ts are filled in).
 */
export const NETWORK = "testnet";
