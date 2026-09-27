"use client";

/**
 * Log in, sign in once (free message signature) and go back to where you
 * came from. Used by the forum pages, which are plain HTML.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectButton } from "@/components/chrome";
import { useWallet } from "@/components/wallet";
import { ensureSession, useAlerts } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function safeNext(v: string | null): string {
  // Only our own pages, never another site.
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return "/forum/";
  return v;
}

function Login() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { address, embedded, signMessage } = useWallet();
  const { address: storeAddress, signedIn } = useAlerts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tried = useRef("");

  // Signed in: back to the forum (skipping its short cache so the page shows you as logged in).
  useEffect(() => {
    if (address && signedIn && storeAddress === address.toLowerCase()) {
      const [path, hash] = next.split("#");
      location.replace(`${path}${path.includes("?") ? "&" : "?"}fresh=1${hash ? `#${hash}` : ""}`);
    }
  }, [address, signedIn, storeAddress, next]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      await ensureSession(signMessage);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  // Email / Google users sign without a popup: do it straight away.
  useEffect(() => {
    if (address && embedded && !signedIn && storeAddress === address.toLowerCase() && tried.current !== address) {
      tried.current = address;
      void signIn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, embedded, signedIn, storeAddress]);

  return (
    <div className="max-w-md mx-auto px-4 py-12 sm:py-16">
      <h1 className="font-display font-semibold text-[1.75rem] sm:text-[2rem] tracking-tight">Log in to sasa</h1>
      <p className="text-ink-2 mt-3 leading-relaxed">
        Log in to post on the forum, like posts and get alerts. No wallet needed: email or Google works, and it&apos;s free.
      </p>
      <div className="mt-6">
        {!address ? (
          <ConnectButton full />
        ) : signedIn ? (
          <p className="text-ink-2">Taking you back…</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={busy}
              className="h-14 w-full rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] hover:bg-emerald-dark disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {!embedded && <p className="text-[0.8125rem] text-ink-3 mt-2 text-center">Your wallet asks you to sign a message once. It&apos;s free and sends nothing.</p>}
          </>
        )}
        {error && (
          <p className="text-[0.875rem] text-danger mt-3" role="alert">
            {error}
          </p>
        )}
      </div>
      <a href={next} className="inline-block mt-8 text-[0.875rem] font-semibold text-emerald">
        ← Back without logging in
      </a>
    </div>
  );
}
