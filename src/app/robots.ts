import type { MetadataRoute } from "next";
import { appUrl } from "@/server/config/env";

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
        "/settings",
        "/admin",
        "/api/",
        "/auth/",
        "/complete-signup",
        "/verify-email",
        "/reset-password",
        "/extension/",
        "/oauth/",
        "/save",
      ],
    },
    sitemap: `${appUrl}/sitemap.xml`,
  };
}
