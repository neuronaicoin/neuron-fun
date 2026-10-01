import Link from "next/link";
import { SasaMark } from "./landing";
import type { Block } from "@/lib/articles";
import { CurveSim } from "./curvesim";

const X_URL = "https://x.com/sasapadfun";

export function LearnHeader() {
  return (
    <header className="border-b border-line">
      <div className="max-w-3xl mx-auto px-5 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5" aria-label="sasa home">
          <SasaMark size={32} />
          <span className="font-display font-bold text-[1.3125rem] tracking-tight">sasa</span>
        </a>
        <nav className="flex items-center gap-2 text-[0.875rem]">
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
      <div className="max-w-3xl mx-auto px-5 py-8 flex flex-wrap gap-x-6 gap-y-2 justify-between text-[0.8125rem] text-ink-3">
        <span>© {new Date().getFullYear()} sasa · Launch once. Live on every chain.</span>
        <span>Meme coins are risky. Nothing here is financial advice.</span>
      </div>
    </footer>
  );
}

/**
 * Inline links in article text: [words](/path/) for pages on sasa (internal
 * links) and [words](https://...) for sources. Everything else is plain text.
 */
export function Rich({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(((?:\/|https:\/\/)[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [, label, href] = m;
    parts.push(
      href.startsWith("/") ? (
        <Link key={m.index} href={href} className="text-emerald font-semibold underline underline-offset-2 decoration-emerald/40 hover:decoration-emerald">
          {label}
        </Link>
      ) : (
        <a key={m.index} href={href} target="_blank" rel="noopener" className="text-emerald font-semibold underline underline-offset-2 decoration-emerald/40">
          {label}
        </a>
      )
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** "In short": the answer first, for readers in a hurry and for search and AI engines. */
export function Takeaways({ items }: { items: string[] }) {
  return (
    <aside className="rounded-3xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="in-short">
      <h2 id="in-short" className="font-display font-bold text-[1.125rem]">In short</h2>
      <ul className="mt-3 grid gap-2 text-[1rem] leading-relaxed text-ink-2 pl-5 list-disc marker:text-emerald">
        {items.map((t) => (
          <li key={t}>
            <Rich text={t} />
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function ArticleBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="grid gap-5 text-[1.0625rem] leading-[1.75] text-ink-2">
      {blocks.map((b, i) => {
        if ("h2" in b) return <h2 key={i} className="font-display font-bold text-[1.5rem] text-ink mt-6 leading-snug">{b.h2}</h2>;
        if ("p" in b) return <p key={i}><Rich text={b.p} /></p>;
        if ("ul" in b)
          return (
            <ul key={i} className="grid gap-2 pl-5 list-disc marker:text-emerald">
              {b.ul.map((x, j) => <li key={j}><Rich text={x} /></li>)}
            </ul>
          );
        if ("ol" in b)
          return (
            <ol key={i} className="grid gap-2 pl-5 list-decimal marker:text-emerald marker:font-semibold">
              {b.ol.map((x, j) => <li key={j}><Rich text={x} /></li>)}
            </ol>
          );
        if ("widget" in b) return <div key={i} className="text-[1rem] leading-normal"><CurveSim /></div>;
        return (
          <aside key={i} className="rounded-2xl border border-emerald/40 bg-emerald-soft px-5 py-4 text-ink">
            <Rich text={b.tip} />
          </aside>
        );
      })}
    </div>
  );
}

export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
