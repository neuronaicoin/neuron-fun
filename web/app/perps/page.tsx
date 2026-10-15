"use client";

/** The old Perps address: Futures now lives at /futures/ (the market in ?c= carries over). */
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    window.location.replace(`/futures/${window.location.search}`);
  }, []);
  return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
}
