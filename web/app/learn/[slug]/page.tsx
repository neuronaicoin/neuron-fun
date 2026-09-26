import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ARTICLES, SITE_URL, articleBySlug } from "@/lib/articles";
import { ArticleBody, JsonLd, LearnFooter, LearnHeader } from "@/components/learn";

export const dynamicParams = false;

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = articleBySlug((await params).slug);
  if (!a) return {};
  const url = `/learn/${a.slug}/`;
  return {
    title: `${a.title} | sasa`,
    description: a.description,
    alternates: { canonical: url },
    openGraph: { title: a.title, description: a.description, url, type: "article", publishedTime: a.date, modifiedTime: a.updated, images: ["/og.png"] },
    twitter: { card: "summary_large_image", title: a.title, description: a.description, images: ["/og.png"] },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const a = articleBySlug((await params).slug);
  if (!a) notFound();
  const others = ARTICLES.filter((x) => x.slug !== a.slug);
  const url = `${SITE_URL}/learn/${a.slug}/`;
  return (
    <div className="min-h-dvh flex flex-col bg-mist">
      <LearnHeader />
      <main className="flex-1 max-w-3xl w-full mx-auto px-5 py-10 sm:py-14">
        <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3">
          <Link href="/learn/" className="hover:text-ink">Learn</Link> <span aria-hidden="true">/</span>
        </nav>
        <article>
          <h1 className="font-display font-bold text-[32px] sm:text-[44px] tracking-tight mt-3 leading-[1.08]">{a.title}</h1>
          <p className="text-[14px] text-ink-3 mt-4 font-mono">
            {a.readMin} min read · Updated {new Date(a.updated).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </p>
          <div className="mt-8">
            <ArticleBody blocks={a.body} />
          </div>

          <section className="mt-12" aria-labelledby="faq">
            <h2 id="faq" className="font-display font-bold text-[24px]">Questions</h2>
            <div className="mt-4 grid gap-3">
              {a.faq.map((f) => (
                <details key={f.q} className="rounded-2xl border border-line bg-surface px-5 py-4 group">
                  <summary className="font-semibold cursor-pointer list-none flex justify-between gap-4">
                    {f.q}
                    <span className="text-ink-3 group-open:rotate-45 transition-transform" aria-hidden="true">+</span>
                  </summary>
                  <p className="text-ink-2 mt-3 leading-relaxed">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </article>

        <section className="mt-12 rounded-3xl border border-line bg-surface p-6 sm:p-8">
          <p className="font-display font-bold text-[22px]">Launch once. Live on every chain.</p>
          <p className="text-ink-2 mt-2">sasa is live on testnet and coming to mainnet soon.</p>
          <a href="https://x.com/sasapadfun" target="_blank" rel="noreferrer" className="inline-flex mt-5 h-12 px-6 rounded-full bg-ink text-on-accent font-bold items-center">
            Follow @sasapadfun
          </a>
        </section>

        <section className="mt-12" aria-labelledby="more">
          <h2 id="more" className="font-display font-bold text-[20px]">Keep reading</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {others.map((o) => (
              <li key={o.slug}>
                <Link href={`/learn/${o.slug}/`} className="block h-full rounded-2xl border border-line bg-surface p-5 hover:border-emerald/60">
                  <span className="font-semibold leading-snug">{o.title}</span>
                  <span className="block text-[13px] text-ink-3 mt-2">{o.readMin} min read</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <LearnFooter />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Article",
              headline: a.title,
              description: a.description,
              datePublished: a.date,
              dateModified: a.updated,
              mainEntityOfPage: url,
              image: `${SITE_URL}/og.png`,
              author: { "@type": "Organization", name: "sasa", url: SITE_URL },
              publisher: { "@type": "Organization", name: "sasa", url: SITE_URL, logo: { "@type": "ImageObject", url: `${SITE_URL}/sasa-icon-192.png` } },
            },
            {
              "@type": "FAQPage",
              mainEntity: a.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
            },
            {
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 1, name: "Learn", item: `${SITE_URL}/learn/` },
                { "@type": "ListItem", position: 2, name: a.title, item: url },
              ],
            },
          ],
        }}
      />
    </div>
  );
}
