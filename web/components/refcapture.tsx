"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { claimQuest, claimRef, pendingRef, rememberRef } from "@/lib/points";
import { SHARED_X_EVENT } from "./share";

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

  // Any "Post on X" from sasa completes the share quest (once per wallet).
  useEffect(() => {
    if (!address) return;
    const key = `sasa-q-share_x:${address.toLowerCase()}`;
    const on = () => {
      try {
        if (localStorage.getItem(key)) return;
      } catch {}
      claimQuest(signMessage, "share_x")
        .then(() => {
          try {
            localStorage.setItem(key, "1");
          } catch {}
          toast("📣 Thanks for sharing! +100 points");
        })
        .catch(() => {});
    };
    window.addEventListener(SHARED_X_EVENT, on);
    return () => window.removeEventListener(SHARED_X_EVENT, on);
  }, [address, signMessage]);

  return null;
}
