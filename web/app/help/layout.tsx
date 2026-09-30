import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help · sasa",
  description: "Answers to common questions about sasa, and a way to reach the team.",
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
