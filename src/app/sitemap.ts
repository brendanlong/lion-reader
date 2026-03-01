import type { MetadataRoute } from "next";
import { DEMO_ARTICLES } from "./demo/articles";
import { DEMO_SUBSCRIPTIONS, DEMO_TAGS } from "./demo/data";

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://lionreader.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const demoSubscriptionPages = DEMO_SUBSCRIPTIONS.map((sub) => ({
    url: `${appUrl}/demo/subscription/${sub.id}`,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  const demoTagPages = DEMO_TAGS.map((tag) => ({
    url: `${appUrl}/demo/tag/${tag.id}`,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  const demoArticlePages = DEMO_ARTICLES.map((article) => ({
    url: `${appUrl}/demo/all?entry=${article.id}`,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  return [
    {
      url: appUrl,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${appUrl}/login`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${appUrl}/register`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${appUrl}/privacy`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${appUrl}/terms`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${appUrl}/demo/all`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${appUrl}/demo/highlights`,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    ...demoSubscriptionPages,
    ...demoTagPages,
    ...demoArticlePages,
  ];
}
