import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "plugins",
  subscriptionId: "integrations",
  type: "web",
  url: null,
  title: "Plugin System",
  author: null,
  summary:
    "Extensible plugin architecture for integrating with LessWrong, Google Docs, ArXiv, GitHub, and Bluesky.",
  publishedAt: new Date("2026-01-20T12:00:00Z"),
  starred: false,
  heroImage: "/demo/plugins.png",
  heroImageAlt:
    "The Lion Reader lion with colorful modular puzzle pieces for different content sources snapping into place.",
  summaryHtml: `<p>Lion Reader&rsquo;s plugin system uses a <strong>capability-based architecture</strong> to integrate with external content sources. Plugins declare <code>feed</code> and <code>savedArticle</code> capabilities, enabling custom feed processing and article fetching for platforms like <strong>LessWrong</strong>, <strong>Google Docs</strong>, <strong>ArXiv</strong>, <strong>GitHub</strong>, and <strong>Bluesky</strong>. Plugins are matched by hostname with O(1) lookup and fall back gracefully when they can&rsquo;t handle a URL.</p>`,
  contentHtml: `
    <h2>Extensible Content Sources</h2>

    <p>Not all content lives in standard RSS feeds &mdash; and even when it does, the feed sometimes leaves out the good parts. Research papers on <a href="https://arxiv.org/" target="_blank" rel="noopener noreferrer">ArXiv</a>, posts on <a href="https://www.lesswrong.com/" target="_blank" rel="noopener noreferrer">LessWrong</a>, documents in Google Docs, code on GitHub, and posts on <a href="https://bsky.app/" target="_blank" rel="noopener noreferrer">Bluesky</a> each have their own formats and APIs. Lion Reader&rsquo;s plugin system provides a clean way to integrate with these platforms, so you can subscribe to feeds and save articles from them just like any other source.</p>

    <h3>Capability-Based Architecture</h3>

    <p>Each plugin declares the capabilities it supports:</p>

    <ul>
      <li><strong>Feed capability</strong> &mdash; Transform URLs into feed URLs, clean entry content, and customize feed titles. This lets you subscribe to content sources that don&rsquo;t expose standard RSS feeds.</li>
      <li><strong>Saved article capability</strong> &mdash; Fetch and process content from URLs when you <a href="/demo/all?entry=save-for-later"><strong>save articles</strong></a>. This lets you save content from platforms that require API access or special handling to extract clean text.</li>
    </ul>

    <p>Plugins are registered by hostname for fast O(1) lookup. When Lion Reader encounters a URL, it checks the registry for a matching plugin and uses its capabilities. If no plugin matches, or the plugin returns <code>null</code>, standard processing takes over.</p>

    <h3>LessWrong</h3>

    <p>The LessWrong plugin supports both feed and saved article capabilities. For feeds, it transforms user profile URLs (like <code>/users/eliezer_yudkowsky</code>) into <a href="https://graphql.org/" target="_blank" rel="noopener noreferrer">GraphQL</a>-powered RSS feeds, cleans the &ldquo;Published on&hellip;&rdquo; prefix from entry content, and appends author display names to feed titles. For saved articles, it fetches full post and comment content directly through the LessWrong GraphQL API, producing clean HTML without needing Readability post-processing.</p>

    <h3>Google Docs</h3>

    <p>The Google Docs plugin provides saved article capability, letting you save Google Docs directly to Lion Reader. It extracts the document ID from the URL, fetches the content through the Google Docs API, and preserves formatting. The document title and author are extracted automatically, and the canonical URL is normalized for deduplication.</p>

    <h3>ArXiv</h3>

    <p>The ArXiv plugin handles saved articles from <code>arxiv.org</code>. It recognizes abstract, PDF, and HTML URLs, and prefers the HTML version when available for better readability. Unlike the LessWrong and Google Docs plugins, ArXiv content still goes through Readability for cleanup, since the HTML pages include navigation and other site chrome.</p>

    <h3>GitHub</h3>

    <p>The GitHub plugin is the most versatile, handling several types of GitHub content:</p>

    <ul>
      <li><strong>Gists</strong> &mdash; Fetches gist content via the GitHub API and renders files with Markdown support</li>
      <li><strong>Repository files</strong> &mdash; Fetches file content from <code>/blob/</code> URLs, rendering Markdown files and falling back to Readability for others</li>
      <li><strong>Repository roots</strong> &mdash; Fetches the README from <code>github.com/owner/repo</code> URLs, trying multiple filename variants</li>
      <li><strong>Raw content</strong> &mdash; Handles <code>raw.githubusercontent.com</code> URLs for direct file access</li>
    </ul>

    <p>The plugin uses GitHub API authentication when available for higher rate limits, and handles rate limiting and missing content gracefully.</p>

    <h3>Bluesky</h3>

    <p>Bluesky publishes a standard RSS feed for every profile, so subscribing already works out of the box &mdash; but that feed collapses each post&rsquo;s embedded content (quote posts, images, link cards, and videos) down to a bare <em>&ldquo;contains quote post or other embedded content&rdquo;</em> placeholder. The Bluesky plugin fills that gap with a saved-article capability: it hydrates a post through the public <a href="https://atproto.com/" target="_blank" rel="noopener noreferrer">AT Protocol</a> appview &mdash; resolving the handle to a persistent identifier, then fetching the post &mdash; and renders the text (with links, mentions, and hashtags) alongside its embeds as clean HTML, no Readability needed.</p>

    <p>Because those embeds are the whole point of most posts, a plugin can also declare that new subscriptions to a source should default to <strong>full content</strong>. Bluesky opts in, so fresh Bluesky subscriptions automatically hydrate each post&rsquo;s embedded content as you open it &mdash; you can still turn that off per subscription.</p>

    <h3>Adding New Plugins</h3>

    <p>The plugin system is designed to be extensible. A new plugin needs to define its name, the hostnames it handles, a <code>matchUrl</code> function for more specific URL matching, and one or more capabilities. Once registered in the plugin registry, it automatically integrates with feed fetching and article saving across the entire application &mdash; including the web UI, <a href="/demo/all?entry=mcp-server">MCP server</a>, and <a href="/demo/all?entry=discord-bot">Discord bot</a>.</p>
  `,
};

export default article;
