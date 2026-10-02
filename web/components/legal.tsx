import Link from "next/link";

export const LEGAL_UPDATED = "October 2026";

/** Plain page layout for the legal texts (readable, no app chrome inside). */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <h1 className="font-display font-bold text-[1.75rem] sm:text-[2.25rem] tracking-tight">{title}</h1>
      <p className="text-[0.8125rem] text-ink-3 mt-1">Last updated {LEGAL_UPDATED}</p>
      <div className="legal mt-6 grid gap-4 text-[0.9375rem] leading-relaxed text-ink-2 [&_h2]:font-display [&_h2]:font-bold [&_h2]:text-ink [&_h2]:text-[1.125rem] [&_h2]:mt-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:grid [&_ul]:gap-1.5 [&_b]:text-ink">
        {children}
      </div>
      <p className="mt-10 text-[0.8125rem] text-ink-3">
        See also <Link href="/terms/" className="text-emerald">Terms</Link> · <Link href="/privacy/" className="text-emerald">Privacy</Link> ·{" "}
        <Link href="/risk/" className="text-emerald">Risks</Link> · Questions: <Link href="/help/" className="text-emerald">Help</Link>
      </p>
    </article>
  );
}
