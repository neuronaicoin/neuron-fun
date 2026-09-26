import Link from "next/link";
import { SasaMark } from "./landing";
import type { Block } from "@/lib/articles";

const X_URL = "https://x.com/sasapadfun";

export function LearnHeader() {
  return (
    <header className="border-b border-line">
      <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5" aria-label="sasa home">
          <SasaMark size={32} />
          <span className="font-display font-bold text-[21px] tracking-tight">sasa</span>
        </a>
        <nav className="flex items-center gap-2 text-[14px]">
          <Link href="/learn/" className="h-9 px-3 rounded-full flex items-center font-semibold text-ink-2 hover:text-ink">Learn</Link>
          <a href={X_URL} target="_blank" rel="noreferrer" className="h-9 px-4 rounded-full border border-line flex items-center font-semibold hover:border-emerald">
            Follow on X
          </a>
        </nav>
      </div>
    </header>
  );
}

export function LearnFooter() {
  return (
    <footer className="border-t border-line mt-16">
      <div className="max-w-3xl mx-auto px-5 py-8 flex flex-wrap gap-x-6 gap-y-2 justify-between text-[13px] text-ink-3">
        <span>© {new Date().getFullYear()} sasa · Launch once. Live on every chain.</span>
        <span>Meme coins are risky. Nothing here is financial advice.</span>
      </div>
    </footer>
  );
}

export function ArticleBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="grid gap-5 text-[17px] leading-[1.75] text-ink-2">
      {blocks.map((b, i) => {
        if ("h2" in b) return <h2 key={i} className="font-display font-bold text-[24px] text-ink mt-6 leading-snug">{b.h2}</h2>;
        if ("p" in b) return <p key={i}>{b.p}</p>;
        if ("ul" in b)
          return (
            <ul key={i} className="grid gap-2 pl-5 list-disc marker:text-emerald">
              {b.ul.map((x, j) => <li key={j}>{x}</li>)}
            </ul>
          );
        if ("ol" in b)
          return (
            <ol key={i} className="grid gap-2 pl-5 list-decimal marker:text-emerald marker:font-semibold">
              {b.ol.map((x, j) => <li key={j}>{x}</li>)}
            </ol>
          );
        return (
          <aside key={i} className="rounded-2xl border border-emerald/40 bg-emerald-soft px-5 py-4 text-ink">
            {b.tip}
          </aside>
        );
      })}
    </div>
  );
}

export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
