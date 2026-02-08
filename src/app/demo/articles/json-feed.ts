import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "json-feed",
  subscriptionId: "feed-types",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/188",
  title: "JSON Feed Support",
  author: null,
  summary:
    "Native support for JSON Feed, a modern syndication format that uses JSON instead of XML.",
  publishedAt: new Date("2025-12-26T14:00:00Z"),
  starred: false,
  summaryHtml: `<p>JSON Feed is a modern syndication format using JSON instead of XML, making it easier to produce and consume. It supports multiple authors, tags, and both HTML and plain text content. Lion Reader provides <strong>full native support</strong> for JSON Feed versions 1.0 and 1.1 alongside RSS and Atom.</p>`,
  contentHtml: `
    <h2>JSON Feed: Syndication for the Modern Web</h2>

    <p>JSON Feed is a modern syndication format that uses JSON instead of XML, making it dramatically easier to produce and consume programmatically. Launched in 2017 as a simpler alternative to RSS and Atom, JSON Feed was designed with modern web development practices in mind. Lion Reader provides full native support for JSON Feed versions 1.0 and 1.1, treating it as a first-class citizen alongside RSS and Atom.</p>

    <h3>Why JSON Feed?</h3>

    <p>If you&rsquo;ve ever worked with XML parsing, you know the pain: verbose schemas, namespace handling, and complex parsing libraries. JSON Feed eliminates this complexity by using a format that JavaScript developers already know and love. It supports everything you need from a modern feed: multiple authors, tags, both HTML and plain text content, and extensibility through custom fields. Lion Reader auto-detects JSON Feed just like RSS and Atom feeds, so subscribing is as simple as pasting any URL.</p>

    <h3>Developer-Friendly Syndication</h3>

    <p>For content creators and developers building publishing platforms, JSON Feed is a breath of fresh air. You can generate a valid feed using nothing more than your language&rsquo;s built-in JSON encoder &mdash; no XML libraries required. For readers like Lion Reader, parsing is trivial: deserialize JSON, validate the structure, done. This simplicity reduces bugs and makes the entire syndication ecosystem more reliable.</p>

    <ul>
      <li><a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed Official Site</a></li>
      <li><a href="https://www.jsonfeed.org/version/1.1/" target="_blank" rel="noopener noreferrer">JSON Feed Version 1.1 Specification</a></li>
    </ul>
  `,
};

export default article;
