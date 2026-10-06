import { ARTICLES, SITE_URL } from "@/lib/articles";

export const dynamic = "force-static";

// Markdown links in the guides point at site paths: make them absolute for AI readers.
const links = (s: string) => s.replace(/\[([^\]]+)\]\((\/[^)]*)\)/g, (_, t: string, u: string) => `[${t}](${SITE_URL}${u})`);

/** Every sasa guide in full, as plain Markdown for AI answer engines (linked from /llms.txt). */
export function GET() {
  const out: string[] = [
    "# sasa guides (full text)",
    "",
    `> Every guide from ${SITE_URL}/learn/ in one file. sasa is a multi-chain meme coin launchpad and trading app on Robinhood Chain and Base: one launch goes live on several chains at once, buys on every chain count toward one graduation target, and everything is priced in USDC.`,
    "",
  ];
  for (const a of ARTICLES) {
    out.push(`## ${a.title}`, "", `URL: ${SITE_URL}/learn/${a.slug}/ · Updated ${a.updated}`, "", a.description, "");
    if (a.takeaways?.length) out.push("In short:", ...a.takeaways.map((t) => `- ${links(t)}`), "");
    for (const b of a.body) {
      if ("h2" in b) out.push(`### ${b.h2}`, "");
      else if ("p" in b) out.push(links(b.p), "");
      else if ("ul" in b) out.push(...b.ul.map((x) => `- ${links(x)}`), "");
      else if ("ol" in b) out.push(...b.ol.map((x, i) => `${i + 1}. ${links(x)}`), "");
      else if ("tip" in b) out.push(`Tip: ${links(b.tip)}`, "");
    }
    if (a.faq.length) {
      out.push("### Questions", "");
      for (const f of a.faq) out.push(`Q: ${f.q}`, `A: ${links(f.a)}`, "");
    }
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
