"use client";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { funnel, startFunnel } from "@/lib/funnel";

/** Logs each page the visitor opens (lib/funnel.ts). Renders nothing. */
export function FunnelTracker() {
  const path = usePathname();
  useEffect(() => {
    startFunnel();
  }, []);
  useEffect(() => {
    funnel("page", path);
  }, [path]);
  return null;
}
