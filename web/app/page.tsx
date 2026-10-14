import type { Metadata } from "next";
import { Discover } from "@/components/explore";

export const metadata: Metadata = { alternates: { canonical: "/" } };

/** sasapad.fun shows the launch page here; the app's Explore lives at /explore/. */
export default function Home() {
  return <Discover withLanding />;
}
