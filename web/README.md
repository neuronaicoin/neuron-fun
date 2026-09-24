# Neuron.fun website

Static Next.js site. Reads the chain directly from the browser; there is no server.

- Build: `npm run build` → static files in `out/`
- Contract addresses and network: `lib/config.ts`

Cloudflare Pages settings: root directory `web`, build command `npm run build`, output directory `out`.
