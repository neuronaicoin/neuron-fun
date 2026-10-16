"use client";

/** One trader's live positions and trades (?a=0x…). */
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { WhaleProfile } from "@/components/whaleprofile";

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const q = useSearchParams();
  return <WhaleProfile address={(q.get("a") ?? "").trim().slice(0, 42)} />;
}
