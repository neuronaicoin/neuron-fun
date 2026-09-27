/** Forum links, built exactly like the server does (edge/forum-core.js). */
import { db } from "./data";

export function slugify(s: string, max = 60): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function forumBoardUrl(coin: { name: string; symbol: string; launchKey: string }): string {
  const name = slugify(coin.name, 40) || "coin";
  const sym = slugify(coin.symbol, 16);
  const key = coin.launchKey.slice(2, 10);
  return `/forum/${[name, sym && sym !== name ? sym : "", key].filter(Boolean).join("-")}/`;
}

export type ForumThread = { id: number; title: string; author: string; lastPostAt: string; replies: number; url: string };

/** Latest threads on one coin's board (public view, no login needed). */
export async function fetchCoinThreads(coin: { id: string; name: string; symbol: string; launchKey: string }, limit = 3): Promise<ForumThread[]> {
  const { data, error } = await db
    .from("forum_threads_public")
    .select("id,title,author,last_post_at,reply_count")
    .eq("board", coin.id)
    .order("last_post_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const base = forumBoardUrl(coin);
  return (data ?? []).map((t) => ({
    id: Number(t.id),
    title: t.title as string,
    author: t.author as string,
    lastPostAt: t.last_post_at as string,
    replies: Number(t.reply_count ?? 0),
    url: `${base}${t.id}-${slugify(t.title as string, 70) || "thread"}/`,
  }));
}
