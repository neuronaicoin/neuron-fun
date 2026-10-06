import type { MetadataRoute } from "next";
import { ARTICLES, SITE_URL } from "@/lib/articles";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/learn/`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/forum/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/explore/`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/traders/`, changeFrequency: "hourly", priority: 0.7 },
    // Daily "top meme coins" lists (Cloudflare function, rebuilt every 30 minutes).
    { url: `${SITE_URL}/top/`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/top/trending-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/robinhood-chain-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/base-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/bnb-chain-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/ethereum-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/arc-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/meme-coin-gainers/`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${SITE_URL}/top/new-meme-coins/`, changeFrequency: "hourly", priority: 0.8 },
    ...ARTICLES.map((a) => ({ url: `${SITE_URL}/learn/${a.slug}/`, lastModified: a.updated, changeFrequency: "monthly" as const, priority: 0.7 })),
  ];
}
