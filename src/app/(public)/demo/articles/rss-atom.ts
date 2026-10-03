import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "rss-atom",
  subscriptionId: "feed-types",
  type: "web",
  url: null,
  title: "Follow Any Website",
  author: null,
  summary:
    "Paste a link to almost any blog, news site, or publication and Lion Reader finds its feed. New posts arrive automatically, often within seconds of publishing.",
  publishedAt: new Date("2025-12-26T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Paste a link to almost any website and Lion Reader finds its feed automatically, showing recent posts before you subscribe. It reads <strong>RSS, Atom, and JSON Feed</strong>, follows a feed to its new address if it moves, and backs off from sites that are down. Sites that support it push new posts instantly.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Paste a link to almost any blog, news site, or publication and Lion Reader finds its feed for you &mdash; you don&rsquo;t need to hunt for an RSS button. You&rsquo;ll see the feed&rsquo;s title and a few recent posts before you subscribe, so you know what you&rsquo;re signing up for.</p>

    <p>From then on, new posts show up in your list on their own. Many sites notify Lion Reader the moment they publish, so their posts arrive within seconds; the rest are checked regularly throughout the day.</p>

    <h3>Every Standard Format</h3>

    <p>Lion Reader reads all the common feed formats &mdash; RSS, Atom, and <a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed</a> &mdash; and treats them all the same. For sites that don&rsquo;t publish a normal feed, or whose feed leaves out the good parts, <a href="/demo/all?entry=plugins">smart content sources</a> fill in the gaps, and <a href="/demo/all?entry=full-content">full content fetching</a> handles feeds that only send a teaser.</p>

    <h3>Feeds That Keep Working</h3>

    <p>When a site moves its feed, Lion Reader follows it to the new address. When a site is down, Lion Reader keeps trying again later until it comes back.</p>

    <details>
      <summary>How Lion Reader checks feeds</summary>
      <p>Lion Reader asks each site whether anything has changed before downloading the whole feed, and respects the site&rsquo;s own hints about how often to check. Sites that support instant notifications (<a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">WebSub</a>) push new posts to Lion Reader as soon as they&rsquo;re published, so they only need an occasional backup check.</p>
    </details>
  `,
};

export default article;
