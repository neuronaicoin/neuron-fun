"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { claimRef, pendingRef, rememberRef } from "@/lib/points";

/**
 * Invite links: remembers ?ref= on any page, and once the visitor is logged
 * in, links them to whoever invited them (the server checks it's a new user).
 */
export function RefCapture() {
  const { address, signMessage } = useWallet();
  const tried = useRef<string | null>(null);

  useEffect(() => {
    rememberRef();
  }, []);

  useEffect(() => {
    if (!address || tried.current === address) return;
    const ref = pendingRef();
    if (!ref) return;
    tried.current = address;
    claimRef(signMessage, ref)
      .then((r) => {
        if (r.ok) toast("🎁 Welcome! You start with 100 points.");
      })
      .catch(() => {
        tried.current = null; // try again next time
      });
  }, [address, signMessage]);

  return null;
}
