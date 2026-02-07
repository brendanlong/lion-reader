import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "rss-atom",
  subscriptionId: "feed-types",
  type: "web",
  url: null,
  title: "RSS & Atom Feeds",
  author: null,
  summary: "Subscribe to any RSS 2.0 or Atom feed with automatic detection and efficient polling.",
  publishedAt: new Date("2025-12-26T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader provides comprehensive RSS/Atom feed support with intelligent fetching and efficient parsing:</p>
<p><strong>Feed Format Support</strong>: Compatible with RSS 2.0, Atom 1.0, and JSON Feed. Automatically discovers feeds by checking HTML link tags and common paths like /feed, /rss, and /atom.xml.</p>
<p><strong>Smart Polling</strong>: Uses HTTP conditional requests (ETag, If-Modified-Since headers) to minimize bandwidth, receiving 304 Not Modified responses when content is unchanged. Respects Cache-Control headers while maintaining 1-minute to 7-day polling bounds.</p>
<p><strong>Error Resilience</strong>: Intelligently handles redirects—tracking 301 permanent redirects and updating URLs after 3 confirmations, while following temporary redirects without changing stored URLs. Applies exponential backoff (max 7 days) for failed fetches.</p>
<p><strong>Performance</strong>: Leverages fast-xml-parser in SAX streaming mode for memory-efficient parsing of feeds of any size.</p>`,
  contentHtml: `
    <h2>Modern Syndication with RSS &amp; Atom</h2>

    <p>Lion Reader supports all major web feed formats: RSS 2.0, Atom 1.0, and JSON Feed. RSS (Really Simple Syndication) and Atom are XML-based syndication formats that allow you to subscribe to websites and receive updates automatically. Simply paste any URL and Lion Reader will discover available feeds by checking HTML <code>&lt;link&gt;</code> tags and common feed paths like <code>/feed</code>, <code>/rss</code>, and <code>/atom.xml</code>. You can preview the feed&rsquo;s title, description, and sample entries before subscribing.</p>

    <h3>Efficient Polling &amp; Smart Scheduling</h3>

    <p>Lion Reader uses HTTP conditional requests to avoid wasting bandwidth on unchanged content. When checking for updates, it sends <code>ETag</code>, <code>If-Modified-Since</code>, and <code>If-None-Match</code> headers so servers can respond with a lightweight 304 Not Modified status if nothing has changed. The polling schedule respects <code>Cache-Control</code> headers from the server while enforcing reasonable bounds: feeds are checked between once per minute and once every 7 days.</p>

    <h3>Graceful Error Handling</h3>

    <p>Lion Reader handles HTTP redirects intelligently: it tracks 301 permanent redirects and updates the feed URL after 3 confirmations, while following 302 and 307 temporary redirects without updating the stored URL. If a feed fails to fetch, exponential backoff is applied with a maximum retry interval of 7 days. This approach ensures Lion Reader is a good citizen of the web while keeping your feeds up to date.</p>

    <h3>Fast &amp; Memory-Efficient Parsing</h3>

    <p>All feeds are parsed using <code>fast-xml-parser</code> in SAX (streaming) mode, which provides excellent performance and low memory usage even for large feeds. This architectural choice allows Lion Reader to handle feeds of any size efficiently.</p>

    <ul>
      <li><a href="https://www.rssboard.org/rss-specification" target="_blank" rel="noopener noreferrer">RSS 2.0 Specification</a></li>
      <li><a href="https://www.rfc-editor.org/rfc/rfc4287" target="_blank" rel="noopener noreferrer">Atom 1.0 Specification (RFC 4287)</a></li>
    </ul>
  `,
};

export default article;
