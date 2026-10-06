"use client";

/** Trader badges: small name tags in rows, chips with the meaning on profiles. */
import { BADGES, useBadges, type BadgeId } from "@/lib/badges";

export function BadgeIcons({ badges, max = 3, className = "" }: { badges: BadgeId[] | undefined; max?: number; className?: string }) {
  if (!badges || badges.length === 0) return null;
  const shown = badges.slice(0, max);
  const label = badges.map((b) => BADGES[b].label).join(", ");
  return (
    <span className={"inline-flex items-center gap-1 shrink-0 align-middle leading-none " + className} title={label} aria-label={`Badges: ${label}`}>
      {shown.slice(0, 2).map((b) => (
        <span key={b} aria-hidden="true" title={`${BADGES[b].label}: ${BADGES[b].about}`} className="h-4 px-1 rounded bg-night-2 text-ink-2 text-[0.625rem] font-semibold flex items-center">
          {BADGES[b].label}
        </span>
      ))}
      {badges.length > Math.min(max, 2) && <span className="text-[0.6875rem] text-ink-3 font-semibold">+{badges.length - Math.min(max, 2)}</span>}
    </span>
  );
}

/** Badges for one address, fetched (batched and cached) on demand. */
export function TraderBadges({ address, max = 3, className = "" }: { address: string; max?: number; className?: string }) {
  const map = useBadges([address]);
  return <BadgeIcons badges={map.get(address.toLowerCase())} max={max} className={className} />;
}

/** Profile chips: icon and name, the meaning on tap/hover. */
export function BadgeChips({ address, className = "" }: { address: string; className?: string }) {
  const badges = useBadges([address]).get(address.toLowerCase()) ?? [];
  if (badges.length === 0) return null;
  return (
    <ul className={"flex flex-wrap gap-1.5 " + className} aria-label="Badges">
      {badges.map((b) => (
        <li key={b}>
          <details className="group relative">
            <summary className="list-none cursor-pointer h-7 px-2.5 rounded-lg border border-line bg-paper text-[0.75rem] font-semibold flex items-center gap-1 whitespace-nowrap hover:border-emerald/60 [&::-webkit-details-marker]:hidden">
              {BADGES[b].label}
            </summary>
            <span className="absolute z-20 left-0 top-full mt-1 w-56 max-w-[70vw] rounded-xl border border-line bg-surface p-2.5 text-[0.75rem] text-ink-2 shadow-lg">
              {BADGES[b].about}
            </span>
          </details>
        </li>
      ))}
    </ul>
  );
}
