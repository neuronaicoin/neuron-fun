"use client";

import { useState } from "react";
import { Sheet } from "./chrome";
import { toast } from "./alerts";
import { useWallet } from "./wallet";
import { postOnX } from "./share";
import { SUPABASE_URL } from "@/lib/config";
import { compactUsd } from "@/lib/format";
import { clock, laneUsd, leadLane, racePhase, type RaceCoin } from "@/lib/race";

const SITE = "https://sasapad.fun";
export const raceShareUrl = (id: string) => `${SITE}/r/?id=${id.toLowerCase()}`;
/** The card the indexer draws for each race (link previews use it too). */
export const raceCardUrl = (id: string) => `${SUPABASE_URL}/storage/v1/object/public/cards/r-${id.toLowerCase().replace(/[^0-9a-z]/g, "-")}.png`;

const chainList = (c: RaceCoin) => {
  const names = c.lanes.map((l) => l.chain.short);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
};
const tags = (c: RaceCoin) => ({ symbol: c.symbol, chains: c.lanes.map((l) => l.chain.short) });

/** Ready-made posts for the race as it stands now (written loosely, like a person would). */
function posts(c: RaceCoin, now: number): { key: string; label: string; text: string }[] {
  const phase = racePhase(c, now);
  const lead = leadLane(c);
  const total = c.totalUsd ?? c.lanes.reduce((s, l) => s + laneUsd(l), 0);
  const out = [
    {
      key: "launch",
      label: "Launch",
      text: `just launched $${c.symbol} on ${chainList(c)} at the same time\n\n5 minutes. whichever chain gets the most money wins and the rest move over. pick your side 👇`,
    },
  ];
  if (phase === "racing" && lead && laneUsd(lead) > 0)
    out.push({
      key: "racing",
      label: "Race is on",
      text: `$${c.symbol} race is live, ${lead.chain.short} leading with ${compactUsd(laneUsd(lead))}\n\n${clock(c.endsAt - now)} left. every buy pushes your chain up`,
    });
  if (c.winner)
    out.push({
      key: "won",
      label: "Winner",
      text: `$${c.symbol} won on ${c.winner.short} 🏁 ${compactUsd(total)} raised in 5 minutes\n\npool is locked for good, holders on the other chains got moved over automatically`,
    });
  else
    out.push({
      key: "join",
      label: "Invite",
      text: `my coin $${c.symbol} is racing on ${c.lanes.length} chains right now. which one are you backing?`,
    });
  return out;
}

/** "Share" button for a race page: the card, a ready post for X, the link. */
export function RaceShareButton({ coin }: { coin: RaceCoin }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-7 px-2.5 rounded-lg border border-line text-[0.75rem] font-semibold hover:border-ink-3 inline-flex items-center gap-1 shrink-0"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Z" /></svg>
        Share
      </button>
      {open && <ShareSheet coin={coin} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareSheet({ coin, onClose }: { coin: RaceCoin; onClose: () => void }) {
  const url = raceShareUrl(coin.id);
  const [noCard, setNoCard] = useState(false);
  const phase = racePhase(coin, Date.now());
  const text = coin.winner
    ? `$${coin.symbol} won the race on ${coin.winner.short} 🏁`
    : phase === "racing"
      ? `$${coin.symbol} is racing on ${coin.lanes.length} chains right now, 5 minutes to pick the winner`
      : `$${coin.symbol} on sasa`;
  return (
    <Sheet title={`Share ${coin.symbol}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {noCard ? (
          <p className="text-[0.8125rem] text-ink-3 rounded-xl border border-line p-3">The picture for this race is being drawn. The link already works.</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={raceCardUrl(coin.id)} alt={`${coin.name} share card`} width={1200} height={630} onError={() => setNoCard(true)} className="w-full h-auto rounded-xl border border-line" />
        )}
        <button type="button" onClick={() => postOnX(text, url, tags(coin))} className="h-11 rounded-full bg-ink text-mist font-semibold text-[0.9375rem]">
          Post on X
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(url).then(() => toast("Link copied")).catch(() => {})}
            className="h-11 rounded-full border border-line font-semibold text-[0.875rem]"
          >
            Copy link
          </button>
          <a href={raceCardUrl(coin.id)} target="_blank" rel="noreferrer" className="h-11 rounded-full border border-line font-semibold text-[0.875rem] flex items-center justify-center">
            Open picture
          </a>
        </div>
      </div>
    </Sheet>
  );
}

/** Creator kit: shown only to the coin's creator, with posts ready to go out. */
export function CreatorKit({ coin, now }: { coin: RaceCoin; now: number }) {
  const { address } = useWallet();
  if (!address || address.toLowerCase() !== coin.creator.toLowerCase()) return null;
  const url = raceShareUrl(coin.id);
  return (
    <section className="rounded-2xl border border-emerald/40 bg-emerald-soft/40 p-4 sm:p-5 flex flex-col gap-3 min-w-0">
      <div>
        <h2 className="text-[1.125rem] font-bold">Promote your coin</h2>
        <p className="text-[0.8125rem] text-ink-2 mt-0.5">Only you see this. Posts are ready to go; the link shows your race card on X and Telegram.</p>
      </div>
      {posts(coin, now).map((p) => (
        <div key={p.key} className="rounded-xl border border-line bg-surface p-3 flex flex-col gap-2 min-w-0">
          <div className="text-[0.75rem] font-semibold text-ink-3">{p.label}</div>
          <p className="text-[0.875rem] whitespace-pre-line break-words">{p.text}</p>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => postOnX(p.text, url, tags(coin))} className="h-9 px-4 rounded-full bg-ink text-mist font-semibold text-[0.8125rem]">
              Post on X
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(`${p.text}\n\n${url}`).then(() => toast("Copied")).catch(() => {})}
              className="h-9 px-4 rounded-full border border-line font-semibold text-[0.8125rem]"
            >
              Copy
            </button>
          </div>
        </div>
      ))}
      <div className="flex gap-2 flex-wrap text-[0.8125rem]">
        <a href={raceCardUrl(coin.id)} target="_blank" rel="noreferrer" className="font-semibold text-emerald-dark underline underline-offset-2">
          Race picture
        </a>
        <span className="text-ink-3">·</span>
        <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`$${coin.symbol} race on sasa`)}`} target="_blank" rel="noreferrer" className="font-semibold text-emerald-dark underline underline-offset-2">
          Share on Telegram
        </a>
      </div>
    </section>
  );
}
