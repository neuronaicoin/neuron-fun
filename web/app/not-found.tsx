import Link from "next/link";

export const metadata = { title: "Page not found · sasa", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center flex flex-col gap-3 items-center">
      <h1 className="text-[1.5rem] font-bold">This page doesn&apos;t exist</h1>
      <p className="text-ink-2">The link may be old or mistyped.</p>
      <div className="flex gap-4 flex-wrap justify-center">
        <Link href="/explore/" className="text-emerald font-semibold">
          Explore coins
        </Link>
        <Link href="/race/launch/" className="text-emerald font-semibold">
          Create a coin
        </Link>
        <Link href="/learn/" className="text-emerald font-semibold">
          Guides
        </Link>
      </div>
    </div>
  );
}
