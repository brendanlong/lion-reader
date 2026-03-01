import type { MetadataRoute } from "next";

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://lionreader.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/demo/", "/login", "/register", "/privacy", "/terms"],
      disallow: [
        "/all",
        "/starred",
        "/saved",
        "/best",
        "/recently-read",
        "/uncategorized",
        "/subscription/",
        "/tag/",
        "/subscribe",
        "/settings/",
        "/admin/",
        "/api/",
        "/auth/",
        "/complete-signup",
        "/extension/",
        "/oauth/",
        "/save",
      ],
    },
    sitemap: `${appUrl}/sitemap.xml`,
  };
}
