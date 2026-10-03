import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "rss-atom",
  subscriptionId: "feed-types",
  type: "web",
  url: null,
  title: "Follow Your Favorite Sites",
  author: null,
  summary:
    "Paste a link to a blog, news site, YouTube channel, or other publication and Lion Reader finds a way to follow it. New posts arrive automatically, often within seconds of publishing.",
  publishedAt: new Date("2025-12-26T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Paste a link to a blog or news site and Lion Reader finds a way to follow it, showing recent posts before you subscribe. Most sites are checked hourly, and many push new posts within seconds. Feeds that move are followed, and ones that keep failing are flagged in Settings.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Paste a link to a blog, news site, YouTube channel, or other publication and Lion Reader finds a way to follow it &mdash; you don&rsquo;t need to hunt for an RSS button. You&rsquo;ll see its title and a few recent posts before you subscribe, so you know what you&rsquo;re signing up for.</p>

    <p>From then on, new posts show up in your list on their own. Most sites are checked about once an hour, and many notify Lion Reader the moment they publish, so their posts arrive within seconds.</p>

    <h3>What You Can Follow</h3>

    <p>Lion Reader follows a site through its feed &mdash; RSS, Atom, or JSON Feed &mdash; which almost every blog and news site publishes, including newsletters on platforms like Substack, which you can follow here or <a href="/demo/all?entry=email-newsletters">by email</a>. For popular sites like YouTube and Bluesky, <a href="/demo/all?entry=plugins">smart content sources</a> bring in the parts a plain feed leaves out, and when a feed only sends a teaser, Lion Reader can <a href="/demo/all?entry=full-content">fetch the full article</a>. A site with no feed at all can&rsquo;t be followed, but you can still <a href="/demo/all?entry=save-for-later">save its pages for later</a>.</p>

    <h3>Feeds That Keep Working</h3>

    <p>When a site moves its feed, Lion Reader follows it to the new address. When a site is down, Lion Reader keeps trying until it comes back, and feeds that keep failing are listed in Settings, so a subscription never goes quiet without you knowing why. And if you unsubscribe and change your mind, resubscribing brings back what you&rsquo;d already read and starred.</p>

    <details>
      <summary>How Lion Reader checks feeds</summary>
      <p>Lion Reader asks each site whether anything has changed before downloading the whole feed, and respects the site&rsquo;s own hints about how often to check. Sites that support instant notifications (<a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">WebSub</a>) push new posts to Lion Reader as soon as they&rsquo;re published, so they only need an occasional backup check.</p>
    </details>
  `,
};

export default article;
