import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/articles";

export const dynamic = "force-static";

// Search engines and AI answer engines are welcome everywhere public.
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended", "bingbot", "Bingbot"];
const PRIVATE = ["/api/", "/login/", "/admin/", "/daily/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE }, ...AI_BOTS.map((ua) => ({ userAgent: ua, allow: "/", disallow: PRIVATE }))],
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/forum/sitemap.xml`, `${SITE_URL}/sitemap-coins.xml`],
    host: SITE_URL,
  };
}
