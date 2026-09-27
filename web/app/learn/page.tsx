import type { Metadata } from "next";
import Link from "next/link";
import { ARTICLES, SITE_URL } from "@/lib/articles";
import { JsonLd, LearnFooter, LearnHeader } from "@/components/learn";

export const metadata: Metadata = {
  title: "Learn — guides to launching and trading meme coins | sasa",
  description:
    "Plain-language guides to meme coin launches: Robinhood Chain, multi-chain launches, bonding curves, graduation and staying safe.",
  alternates: { canonical: "/learn/" },
  openGraph: { title: "Learn | sasa", description: "Guides to launching and trading meme coins across chains.", url: "/learn/", type: "website", images: ["/og.png"] },
};

export default function LearnIndex() {
  return (
    <div className="min-h-dvh flex flex-col bg-mist">
      <LearnHeader />
      <main className="flex-1 max-w-3xl w-full mx-auto px-5 py-12">
        <p className="font-mono text-[0.75rem] tracking-[0.16em] text-emerald">LEARN</p>
        <h1 className="font-display font-bold text-[2.25rem] sm:text-[3rem] tracking-tight mt-3 leading-[1.05]">Guides to launching meme coins</h1>
        <p className="text-[1.0625rem] text-ink-2 mt-4 max-w-xl">Short, honest explanations of how meme coin launches work, across Robinhood Chain, Base and beyond.</p>
        <ul className="mt-10 grid gap-4">
          {ARTICLES.map((a) => (
            <li key={a.slug}>
              <Link href={`/learn/${a.slug}/`} className="block rounded-3xl border border-line bg-surface p-6 hover:border-emerald/60">
                <h2 className="font-display font-bold text-[1.3125rem] leading-snug">{a.title}</h2>
                <p className="text-[0.9375rem] text-ink-2 mt-2">{a.summary}</p>
                <p className="text-[0.8125rem] text-ink-3 mt-3 font-mono">{a.readMin} min read</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <LearnFooter />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "sasa Learn",
          url: `${SITE_URL}/learn/`,
          hasPart: ARTICLES.map((a) => ({ "@type": "Article", headline: a.title, url: `${SITE_URL}/learn/${a.slug}/` })),
        }}
      />
    </div>
  );
}
