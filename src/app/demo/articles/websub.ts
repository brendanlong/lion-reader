import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "websub",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/271",
  title: "WebSub Push Notifications",
  author: null,
  summary: "Receive instant updates from feeds that support the W3C WebSub push protocol.",
  publishedAt: new Date("2025-12-27T10:00:00Z"),
  starred: false,
  summaryHtml: `<p><strong>WebSub</strong> is a W3C standard that enables real-time content delivery by pushing updates directly to subscribers instead of requiring repeated polling. When you subscribe to a compatible feed, Lion Reader automatically detects the WebSub hub URL, subscribes via a verification handshake, and receives instant notifications when new content is published.</p>
<p><strong>Key benefits:</strong></p>
<ul>
<li><strong>Near-instant delivery</strong> — content arrives in seconds</li>
<li><strong>Reduced server load</strong> — fewer requests for both readers and publishers</li>
<li><strong>Lower bandwidth usage</strong> — no repeated fetching of unchanged feeds</li>
<li><strong>Better user experience</strong> — immediate updates for time-sensitive content</li>
</ul>
<p>Lion Reader handles WebSub detection, subscription, renewal, and error handling automatically. For feeds without WebSub support, the app seamlessly falls back to traditional polling.</p>`,
  contentHtml: `
    <h2>What is WebSub?</h2>

    <p>WebSub is a <a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">W3C standard</a> for real-time content delivery, formerly known as PubSubHubbub. Instead of Lion Reader repeatedly checking feeds for new content (polling), WebSub allows publishers to push updates directly to subscribers the moment new content is published. This is the same technology that powers real-time updates across much of the modern web.</p>

    <h3>How It Works</h3>

    <p>When you subscribe to a feed, Lion Reader automatically checks if the feed advertises a WebSub hub URL in its <code>&lt;link&gt;</code> headers. If it does, Lion Reader subscribes to that hub with a callback URL. The hub then verifies the subscription via a challenge-response handshake to ensure the request is legitimate.</p>

    <p>Once subscribed, the publisher&rsquo;s hub pushes new content directly to Lion Reader the moment it&rsquo;s published. Lion Reader processes this pushed content just like a regular fetch &mdash; parsing entries, deduplicating, and notifying you via real-time updates. The entire process happens automatically in the background with no manual configuration required.</p>

    <h3>Benefits Over Polling</h3>

    <ul>
      <li><strong>Near-instant delivery</strong> &mdash; New content arrives in seconds instead of minutes</li>
      <li><strong>Reduced server load</strong> &mdash; Both Lion Reader and the feed publisher benefit from fewer requests</li>
      <li><strong>Lower bandwidth usage</strong> &mdash; No need to repeatedly fetch unchanged feeds</li>
      <li><strong>Better user experience</strong> &mdash; Breaking news and time-sensitive content appears immediately</li>
    </ul>

    <h3>Automatic Detection</h3>

    <p>Lion Reader discovers and subscribes to WebSub hubs automatically for any feed that supports them. For feeds without WebSub support, Lion Reader seamlessly falls back to regular polling. Subscription renewal and error handling are built in, so the system is resilient to hub outages and network issues.</p>
  `,
};

export default article;
