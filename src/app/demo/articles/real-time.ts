import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "real-time",
  subscriptionId: "integrations",
  type: "web",
  url: null,
  title: "Real-Time Updates",
  author: null,
  summary: "See new entries appear instantly with Server-Sent Events and smart cache invalidation.",
  publishedAt: new Date("2025-12-28T16:00:00Z"),
  starred: false,
  heroImage: "/demo/real-time.png",
  heroImageAlt:
    "The Lion Reader lion reading while a conveyor belt delivers a steady stream of fresh newspapers, emails, and books.",
  summaryHtml: `<p>Lion Reader uses <strong>Server-Sent Events (SSE)</strong> and Redis pub/sub for real-time updates without polling. When feeds fetch new content, events publish to per-feed channels, and your browser receives updates instantly. The connection automatically subscribes to relevant feeds, with graceful degradation if Redis fails.</p>`,
  contentHtml: `
    <h2>Server-Sent Events Architecture</h2>

    <p>Lion Reader uses Server-Sent Events (SSE) powered by Redis pub/sub to deliver real-time updates without polling. When a feed worker fetches new content, it publishes events to Redis channels. Your browser maintains an open SSE connection that listens to these channels, receiving updates the moment they happen. This architecture is both efficient and scalable &mdash; your connection only subscribes to events for feeds you actually care about.</p>

    <h3>Channel Types</h3>

    <ul>
      <li><strong>Per-feed channels</strong> &mdash; Each feed has its own channel (<code>feed:{feedId}:events</code>). When you subscribe to a feed, your SSE connection automatically subscribes to that feed&rsquo;s channel. This means you only receive events for feeds you follow, reducing noise and bandwidth.</li>
      <li><strong>Per-user channels</strong> &mdash; Account-level events like subscription changes and OPML import progress use a dedicated user channel (<code>user:{userId}:events</code>). This ensures actions taken in other browser sessions appear instantly across all your devices.</li>
    </ul>

    <h3>Event Types</h3>

    <p>Lion Reader sends several types of real-time events:</p>

    <ul>
      <li><strong>new_entry</strong> &mdash; A new article was published to a feed you subscribe to</li>
      <li><strong>entry_updated</strong> &mdash; An article&rsquo;s content was updated by the publisher</li>
      <li><strong>subscription_created</strong> &mdash; You added a new subscription from another device or session</li>
      <li><strong>import_progress</strong> &mdash; Real-time status updates during OPML import</li>
    </ul>

    <h3>Updates that stay out of your way</h3>

    <p>When an event arrives, new content shows up in your lists automatically &mdash; no page refresh, no clicking to reload. The key detail is <em>how</em>: instead of re-fetching and redrawing the whole list, Lion Reader updates just the data that changed. A new article is inserted at its correct spot by date, and read or starred changes are applied in place. So if you&rsquo;re partway down a list reading, your scroll position and the article in front of you stay put &mdash; updates never yank the page around underneath you. Your own actions (starring, marking read) apply instantly and reconcile automatically if two devices disagree.</p>

    <h3>Reliability and Fallbacks</h3>

    <p>The SSE connection includes a heartbeat keepalive every 30 seconds to detect and recover from network issues. If Redis becomes unavailable, Lion Reader gracefully degrades to a timestamp-based sync endpoint that provides eventual consistency without real-time updates. When you subscribe to a new feed, your SSE connection dynamically starts listening to that feed&rsquo;s channel without reconnecting, ensuring you never miss new content.</p>
  `,
};

export default article;
