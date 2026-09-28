"use client";

import { useEffect, useState } from "react";
import { Sheet } from "./chrome";
import { Avatar, FollowButton } from "./social";
import { db } from "@/lib/data";
import { displayName, profileHref, useProfiles } from "@/lib/social";

/** Followers or following of one wallet, with Follow buttons. */
export function FollowListSheet({ address, kind, onClose }: { address: string; kind: "followers" | "following"; onClose: () => void }) {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    const a = address.toLowerCase();
    const q =
      kind === "followers"
        ? db.from("follows_public").select("follower").eq("followee", a).order("created_at", { ascending: false }).limit(500)
        : db.from("follows_public").select("followee").eq("follower", a).order("created_at", { ascending: false }).limit(500);
    q.then(({ data }) =>
      setList(((data ?? []) as Record<string, string>[]).map((r) => (kind === "followers" ? r.follower : r.followee)))
    );
  }, [address, kind]);
  const profiles = useProfiles(list ?? []);
  return (
    <Sheet title={kind === "followers" ? "Followers" : "Following"} onClose={onClose}>
      {list === null ? (
        <div className="h-32 rounded-2xl bg-line/50 animate-pulse" />
      ) : list.length === 0 ? (
        <p className="text-ink-2">{kind === "followers" ? "No followers yet. Share your profile to get some." : "Not following anyone yet."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => {
            const p = profiles.get(a);
            return (
              <li key={a} className="flex items-center gap-3 py-2.5">
                <a href={p ? profileHref(p) : `/u/${a}/`} className="flex items-center gap-3 min-w-0 flex-1">
                  {p ? <Avatar profile={p} size={38} /> : <span className="w-[38px] h-[38px] rounded-full bg-line shrink-0" />}
                  <span className="font-semibold truncate">{p ? displayName(p) : `${a.slice(0, 6)}…${a.slice(-4)}`}</span>
                </a>
                {p && <FollowButton profile={p} />}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
