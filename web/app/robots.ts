import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/articles";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/login/", "/admin/", "/daily/"] }],
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/forum/sitemap.xml`, `${SITE_URL}/sitemap-coins.xml`],
    host: SITE_URL,
  };
}
