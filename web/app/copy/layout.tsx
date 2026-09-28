import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Copy trading · sasa",
  description: "Copy the traders you trust on sasa. Every trade waits for your Apply or Reject.",
  robots: { index: false, follow: true },
};

export default function CopyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
