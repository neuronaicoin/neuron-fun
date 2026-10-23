"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { sessionToken } from "@/lib/alerts";
import { claimQuest, claimRef, pendingRef, rememberRef } from "@/lib/points";
import { SHARED_X_EVENT } from "./share";

/**
 * Invite links: remembers ?ref= on any page, and once the visitor is logged
 * in, links them to whoever invited them (the server checks it's a new user).
 */
export function RefCapture() {
  const { address, signMessage, embedded } = useWallet();
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
        if (r.ok) toast("Welcome to sasa!");
      })
      .catch(() => {
        tried.current = null; // try again next time
      });
  }, [address, signMessage]);

  // Any "Post on X" from sasa completes the share quest (once per wallet). It never opens a
  // wallet pop-up by itself: an outside wallet (MetaMask…) that isn't signed in to sasa yet keeps
  // the share as "waiting" and it's counted the next time a sign-in already exists. Email accounts
  // sign without a pop-up, so they're counted at once.
  useEffect(() => {
    if (!address) return;
    const key = `sasa-q-share_x:${address.toLowerCase()}`;
    const waitKey = `${key}:waiting`;
    const get = (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    const put = (k: string, v: string | null) => {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {}
    };
    const claim = () => {
      if (get(key)) return;
      if (!embedded && !sessionToken()) {
        put(waitKey, "1");
        return;
      }
      claimQuest(signMessage, "share_x")
        .then(() => {
          put(key, "1");
          put(waitKey, null);
          toast("Thanks for sharing!");
        })
        .catch(() => {});
    };
    window.addEventListener(SHARED_X_EVENT, claim);
    // a share that waited for a sign-in: count it once one exists
    const t = setInterval(() => {
      if (get(waitKey) && !get(key) && (embedded || sessionToken())) claim();
    }, 30_000);
    return () => {
      window.removeEventListener(SHARED_X_EVENT, claim);
      clearInterval(t);
    };
  }, [address, signMessage, embedded]);

  return null;
}
