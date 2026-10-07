"use client";

import { useEffect, useState } from "react";
import { Sheet } from "./chrome";
import { postOnX } from "./share";
import { drawProfitCard, type ProfitInfo } from "@/lib/pnlcard";

/** Shown after a sell that made at least 5%: the card, ready to post. */
export function ProfitCard({ info, link, onClose }: { info: ProfitInfo; link: string; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    drawProfitCard(info)
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch(() => setNote("Could not draw the card."));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [info]);

  const pct = `+${(info.pct * 100).toFixed(info.pct >= 10 ? 0 : 1)}%`;
  const text = `Closed $${info.symbol} at ${pct} on sasa 🧡`;
  const file = blob ? new File([blob], `sasa-${info.symbol}-profit.png`, { type: "image/png" }) : null;
  const canShareFile = !!file && typeof navigator !== "undefined" && !!navigator.canShare && navigator.canShare({ files: [file] });

  const download = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `sasa-${info.symbol}-profit.png`;
    a.click();
  };

  return (
    <Sheet title={`Nice trade · ${pct}`} onClose={onClose}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`Profit card: ${pct} on $${info.symbol}`} className="w-full rounded-2xl border border-line" />
      ) : (
        <div className="w-full aspect-[1200/630] rounded-2xl bg-paper animate-pulse" />
      )}
      <div className="grid gap-2 mt-4">
        {canShareFile ? (
          <button
            type="button"
            onClick={() => navigator.share({ files: [file!], text, url: link }).catch(() => {})}
            className="h-12 rounded-2xl bg-ink text-mist font-bold"
          >
            Share card
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              download();
              postOnX(text, link, { symbol: info.symbol });
              setNote("The card is downloaded. Attach it to your post on X.");
            }}
            className="h-12 rounded-2xl bg-ink text-mist font-bold"
          >
            Post on X
          </button>
        )}
        <button type="button" onClick={download} disabled={!url} className="h-11 rounded-2xl border border-line font-semibold text-[0.875rem] disabled:opacity-40">
          Save image
        </button>
      </div>
      {note && <p className="text-[0.8125rem] text-ink-3 mt-3">{note}</p>}
    </Sheet>
  );
}
