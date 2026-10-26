"use client";

import { useEffect, useRef } from "react";

/**
 * Where a coin page's search section goes (summary, price history, biggest trades, similar
 * coins, questions; written on the server by functions/x/[[path]].js). On a full page load the
 * server already put it at the end of the page: it is moved here, under the coin's trades. When
 * the app opens a coin without a full page load, it is fetched.
 */
/** The server's section left at the end of the page when no coin page took it (the coin didn't load, or the visitor moved on first). */
export function dropStrayCoinSeo() {
  const el = document.querySelector("body > #coin-seo");
  if (!el) return;
  const css = el.previousElementSibling;
  if (css && css.tagName === "STYLE") css.remove();
  el.remove();
}

export function CoinSeoSlot({ network, address }: { network: string; address: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const key = `${network}/${address}`;
    const mine = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).dataset.coin === key;
    if (mine(slot.querySelector("#coin-seo"))) return;
    slot.replaceChildren();
    // the server's section (with its <style> just before it) at the end of the page
    const ready = document.querySelector("body > #coin-seo");
    if (ready) {
      const style = ready.previousElementSibling;
      const css = style && style.tagName === "STYLE" ? style : null;
      if (mine(ready)) {
        if (css) slot.appendChild(css);
        slot.appendChild(ready);
        return;
      }
      // another coin's (the first page opened was a different coin): it goes
      css?.remove();
      ready.remove();
    }
    let alive = true;
    const path = network === "solana" ? `/x/solana/${address}/` : `/x/${encodeURIComponent(network)}/${address.toLowerCase()}/`;
    fetch(`${path}?part=seo`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((html) => {
        if (alive && html && slot.isConnected) slot.innerHTML = html;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [network, address]);
  return <div id="coin-seo-slot" ref={ref} />;
}
