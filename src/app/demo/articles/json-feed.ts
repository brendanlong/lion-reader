import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "json-feed",
  subscriptionId: "feed-types",
  type: "web",
  url: null,
  title: "JSON Feed Support",
  author: null,
  summary:
    "Native support for JSON Feed, a modern syndication format that uses JSON instead of XML.",
  publishedAt: new Date("2025-12-26T14:00:00Z"),
  starred: false,
  summaryHtml: `<p><strong>JSON Feed</strong> is a modern syndication format that uses JSON instead of XML, making feed creation and parsing significantly simpler. Launched in 2017 as an alternative to RSS and Atom, it was designed with contemporary web development practices in mind.</p>
<p><strong>Key advantages:</strong></p>
<ul>
<li><strong>Developer-friendly</strong>: No complex XML parsing libraries needed—just use built-in JSON encoders/decoders</li>
<li><strong>Feature-complete</strong>: Supports attachments, multiple authors, tags, HTML and plain text content, and custom extensions</li>
<li><strong>Reduced complexity</strong>: Eliminates XML&#39;s verbose schemas and namespace handling</li>
</ul>
<p><strong>For Lion Reader users</strong>, JSON Feed works seamlessly alongside RSS and Atom—the app auto-detects and treats all formats equally. Simply paste any URL to subscribe.</p>
<p><strong>For publishers</strong>, generating a JSON Feed is straightforward using any language&#39;s native JSON support, reducing bugs and making syndication more reliable.</p>`,
  contentHtml: `
    <h2>JSON Feed: Syndication for the Modern Web</h2>

    <p>JSON Feed is a modern syndication format that uses JSON instead of XML, making it dramatically easier to produce and consume programmatically. Launched in 2017 as a simpler alternative to RSS and Atom, JSON Feed was designed with modern web development practices in mind. Lion Reader provides full native support for JSON Feed versions 1.0 and 1.1, treating it as a first-class citizen alongside RSS and Atom.</p>

    <h3>Why JSON Feed?</h3>

    <p>If you&rsquo;ve ever worked with XML parsing, you know the pain: verbose schemas, namespace handling, and complex parsing libraries. JSON Feed eliminates this complexity by using a format that JavaScript developers already know and love. It supports everything you need from a modern feed: attachments, multiple authors, tags, both HTML and plain text content, and extensibility through custom fields. Lion Reader auto-detects JSON Feed just like RSS and Atom feeds, so subscribing is as simple as pasting any URL.</p>

    <h3>Developer-Friendly Syndication</h3>

    <p>For content creators and developers building publishing platforms, JSON Feed is a breath of fresh air. You can generate a valid feed using nothing more than your language&rsquo;s built-in JSON encoder &mdash; no XML libraries required. For readers like Lion Reader, parsing is trivial: deserialize JSON, validate the structure, done. This simplicity reduces bugs and makes the entire syndication ecosystem more reliable.</p>

    <ul>
      <li><a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed Official Site</a></li>
      <li><a href="https://www.jsonfeed.org/version/1.1/" target="_blank" rel="noopener noreferrer">JSON Feed Version 1.1 Specification</a></li>
    </ul>
  `,
};

export default article;
