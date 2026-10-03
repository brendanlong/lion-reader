import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "rss-atom",
  subscriptionId: "feed-types",
  type: "web",
  url: null,
  title: "Follow Any Website",
  author: null,
  summary:
    "Paste a link to any blog, news site, or podcast and Lion Reader finds its feed. New posts arrive automatically, often within seconds of publishing.",
  publishedAt: new Date("2025-12-26T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader supports <strong>RSS 2.0 and Atom 1.0</strong> formats with automatic feed discovery. It uses <strong>HTTP conditional requests</strong> and respects Cache-Control headers while polling between once every 10 minutes and once every 7 days. The system handles redirects intelligently and applies exponential backoff for failed fetches.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
  contentHtml: `
    <p>Paste a link to almost any blog, news site, or publication and Lion Reader finds its feed for you &mdash; you don&rsquo;t need to hunt for an RSS button. You&rsquo;ll see the feed&rsquo;s title and a few recent posts before you subscribe, so you know what you&rsquo;re signing up for.</p>

    <p>From then on, new posts show up in your list on their own. Many sites notify Lion Reader the moment they publish, so their posts arrive within seconds; the rest are checked regularly throughout the day.</p>

    <h3>Every Standard Format</h3>

    <p>Lion Reader reads all the common feed formats &mdash; RSS, Atom, and <a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed</a> &mdash; and treats them all the same. For sites that don&rsquo;t publish a normal feed, or whose feed leaves out the good parts, <a href="/demo/all?entry=plugins">smart content sources</a> fill in the gaps, and <a href="/demo/all?entry=full-content">full content fetching</a> handles feeds that only send a teaser.</p>

    <h3>Feeds That Keep Working</h3>

    <p>When a site moves its feed, Lion Reader follows it to the new address. When a site is down, Lion Reader backs off and tries again later instead of giving up, and the sites you follow are never hammered with requests.</p>

    <details>
      <summary>How Lion Reader checks feeds</summary>
      <p>Lion Reader asks each site whether anything has changed before downloading the whole feed, and respects the site&rsquo;s own hints about how often to check. Sites that support <a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">WebSub</a> push new posts to Lion Reader as soon as they&rsquo;re published, so they don&rsquo;t need to be checked at all.</p>
    </details>
  `,
};

export default article;
