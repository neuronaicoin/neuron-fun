import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "sasa Chat: live meme coin chat · sasa",
  description: "Talk meme coins live with everyone on sasa. Short messages, no links, no ads; the last 4 hours of the room.",
  alternates: { canonical: "/chat/" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
