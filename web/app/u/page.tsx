"use client";

/**
 * A trader's profile: sasapad.fun/u/<username or address>/.
 * The server (functions/u) serves this page for every /u/… link.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/wallet";
import { Avatar, EditProfileSheet, FollowButton } from "@/components/social";
import { CopyBadge, CopyButton } from "@/components/copy";
import { CoinAvatar, Skeleton, timeAgo, usd } from "@/components/coins";
import { toast } from "@/components/alerts";
import { coinHref, db, fetchPortfolio, fetchTrades, nativePerToken, type Trade } from "@/lib/data";
import { displayName, fetchProfile, fetchTraderStats, isQuickSeller, reportAvatar, winRate, type Profile, type TraderStats } from "@/lib/social";
import { friendlyError } from "@/lib/format";
import { money, signed } from "@/lib/portfolio";

type Holding = Awaited<ReturnType<typeof fetchPortfolio>>["holdings"][number];

export default function ProfilePage() {
  const { address, signMessage } = useWallet();
  const [key, setKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [week, setWeek] = useState<TraderStats | null>(null);
  const [all, setAll] = useState<TraderStats | null>(null);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const m = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
    setKey(m ? decodeURIComponent(m[1]) : address ? address.toLowerCase() : "");
  }, [address]);

  const load = useCallback(async () => {
    if (key === null) return;
    if (!key) {
      setProfile(null);
      return;
    }
    const p = await fetchProfile(key).catch(() => null);
    setProfile(p);
    if (!p) return;
    // A profile with a username lives at /u/username/.
    if (p.username && key.startsWith("0x") && location.pathname.startsWith("/u/")) history.replaceState(null, "", `/u/${p.username}/`);
    document.title = `${displayName(p)} on sasa`;
    const [w, a, pf, t] = await Promise.all([
      fetchTraderStats(p.address, "w").catch(() => null),
      fetchTraderStats(p.address, "a").catch(() => null),
      fetchPortfolio(p.address).catch(() => null),
      p.hideTrades ? Promise.resolve([] as Trade[]) : fetchTrades({ trader: p.address, limit: 20 }).catch(() => [] as Trade[]),
    ]);
    setWeek(w);
    setAll(a);
    setHoldings(pf ? pf.holdings : []);
    setEthUsd(pf?.prices?.ETH ?? null);
    setTrades(t);
    const ids = [...new Set(t.map((x) => x.coinId))];
    if (ids.length) {
      const { data } = await db.from("coins").select("id,symbol").in("id", ids);
      setNames(new Map(((data ?? []) as { id: string; symbol: string }[]).map((c) => [c.id, c.symbol])));
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  if (profile === undefined) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10 grid gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[1.75rem]">No one here</h1>
        <p className="text-ink-2 mt-2">This profile doesn&apos;t exist. Check the name, or find people on the leaderboard.</p>
        <Link href="/traders/" className="inline-block mt-5 text-emerald font-semibold">🏆 Top traders</Link>
      </div>
    );
  }

  const mine = !!address && address.toLowerCase() === profile.address;
  const wr = winRate(all);
  const eth = (n: number) => (ethUsd !== null ? n * ethUsd : null);
  const rows = (holdings ?? [])
    .map((h) => ({ h, value: eth(h.amount * nativePerToken(h.curve)) ?? 0 }))
    .filter((x) => x.value >= 0.01)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center gap-4">
        <Avatar profile={profile} size={76} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="font-display font-semibold text-[1.625rem] sm:text-[2rem] tracking-tight truncate">{displayName(profile)}</h1>
            {profile.allowCopy && !profile.hideTrades && <CopyBadge className="shrink-0" />}
          </div>
          {profile.bio && <p className="text-ink-2 mt-0.5 leading-snug">{profile.bio}</p>}
          <p className="text-[0.8125rem] text-ink-3 mt-1">
            <b className="text-ink">{profile.followers}</b> followers · <b className="text-ink">{profile.following}</b> following
            {profile.allowCopy && profile.copiers > 0 && (
              <>
                {" "}
                · <b className="text-ink">{profile.copiers}</b> copying
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        {mine ? (
          <button type="button" onClick={() => setEditing(true)} className="h-11 px-5 rounded-xl border border-line font-semibold hover:border-emerald">
            Edit profile
          </button>
        ) : (
          <>
            <FollowButton profile={profile} big />
            {!profile.hideTrades && <CopyButton profile={profile} big />}
          </>
        )}
        <button
          type="button"
          onClick={() => {
            const link = `${location.origin}/u/${profile.username ?? profile.address}/`;
            (navigator.share ? navigator.share({ url: link }) : navigator.clipboard.writeText(link).then(() => toast("Profile link copied"))).catch(() => {});
          }}
          className="h-11 px-5 rounded-xl border border-line font-semibold hover:border-emerald"
        >
          Share
        </button>
      </div>
      {!mine && profile.avatar && address && (
        <button
          type="button"
          onClick={async () => {
            if (!confirm("Report this profile picture as inappropriate?")) return;
            try {
              const removed = await reportAvatar(signMessage, profile.address);
              toast(removed ? "Picture removed" : "Reported. Thanks.");
              if (removed) void load();
            } catch (e) {
              toast(friendlyError(e));
            }
          }}
          className="mt-2 text-[0.75rem] text-ink-3 underline"
        >
          Report picture
        </button>
      )}
      {isQuickSeller(all) && (
        <p className="text-[0.8125rem] text-ink-3 mt-3">⚡ Often sells within minutes of buying. Keep that in mind before following their buys.</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5">
        {(
          [
            ["Profit (7d)", week ? eth(week.realized) : 0, true],
            ["All time", all ? eth(all.realized) : 0, true],
            ["Win rate", wr, false],
            ["Trades", all?.trades ?? 0, false],
          ] as const
        ).map(([label, v, isMoney]) => (
          <div key={label} className="bg-surface border border-line rounded-2xl px-3.5 py-3">
            <div className="text-[0.75rem] text-ink-3">{label}</div>
            <div
              className={
                "font-mono text-[1.0625rem] mt-0.5 " + (isMoney && typeof v === "number" ? (v >= 0 ? "text-up" : "text-danger") : "")
              }
            >
              {label === "Win rate" ? (v === null ? "—" : `${Math.round((v as number) * 100)}%`) : isMoney ? (v === null ? "—" : signed(v as number)) : String(v)}
            </div>
          </div>
        ))}
      </div>

      <h2 className="font-display font-semibold text-[1.125rem] mt-8 mb-2">Holding now</h2>
      {holdings === null ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-ink-2 text-[0.9375rem]">Nothing right now.</p>
      ) : (
        <ul className="bg-surface border border-line rounded-2xl divide-y divide-line">
          {rows.slice(0, 20).map(({ h, value }) => (
            <li key={`${h.coin.id}-${h.curve.chain.key}`}>
              <Link href={coinHref(h.coin)} className="flex items-center gap-3 px-4 py-3 hover:bg-paper">
                <CoinAvatar logo={h.coin.logo} symbol={h.coin.symbol} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold truncate">{h.coin.name}</span>
                  <span className="block text-[0.8125rem] text-ink-3">${h.coin.symbol} · {h.curve.chain.short}</span>
                </span>
                <span className="font-mono">{money(value)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="font-display font-semibold text-[1.125rem] mt-8 mb-2">Recent trades</h2>
      {profile.hideTrades ? (
        <p className="text-ink-2 text-[0.9375rem]">{mine ? "Your trades are hidden. Change it in Edit profile." : "This trader keeps their trades private."}</p>
      ) : trades === null ? (
        <Skeleton className="h-16 w-full" />
      ) : trades.length === 0 ? (
        <p className="text-ink-2 text-[0.9375rem]">No trades yet.</p>
      ) : (
        <ul className="bg-surface border border-line rounded-2xl divide-y divide-line">
          {trades.map((t) => (
            <li key={t.txHash + t.coinId} className="flex items-center gap-3 px-4 py-3">
              <span className={"w-10 font-bold text-[0.875rem] " + (t.isBuy ? "text-up" : "text-danger")}>{t.isBuy ? "Buy" : "Sell"}</span>
              <Link href={coinHref({ id: t.coinId })} className="min-w-0 flex-1 hover:text-emerald">
                <span className="block font-semibold truncate">{names.get(t.coinId) ? `$${names.get(t.coinId)}` : "Coin"}</span>
                <span className="block text-[0.8125rem] text-ink-3">{timeAgo(t.ts)}</span>
              </Link>
              <span className="font-mono">{ethUsd !== null ? usd((t.nativeAmount / 1e18) * ethUsd, 2) : `${(t.nativeAmount / 1e18).toFixed(5)} ETH`}</span>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <EditProfileSheet
          current={profile}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
