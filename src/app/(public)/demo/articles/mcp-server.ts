import { type DemoArticle } from "./types";
import heroImage from "./images/mcp-server.png";
import ogImage from "./images/mcp-server-og.png";

const article: DemoArticle = {
  id: "mcp-server",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/285",
  title: "MCP Server",
  author: null,
  summary: "Connect Lion Reader to AI assistants like Claude via the Model Context Protocol.",
  publishedAt: new Date("2026-01-14T12:00:00Z"),
  starred: true,
  heroImage,
  ogImage,
  heroImageAlt:
    "The Lion Reader lion plugging a connector cable into a friendly robot AI assistant, linking the two together.",
  summaryHtml: `<p>The Model Context Protocol (MCP) lets AI assistants like Claude access Lion Reader&#39;s features directly. The server exposes tools for listing, reading, searching, saving, and starring entries plus managing subscriptions and tags, all through the same services layer as the web UI. Remote clients (e.g. claude.ai) connect over Streamable HTTP with <strong>OAuth 2.1</strong>; local clients use stdio. Access is scoped by <strong>token permissions</strong>.</p>`,
  contentHtml: `
    <h2>What is MCP?</h2>

    <p>The <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a> is an open standard for connecting AI assistants to external tools and data sources. Think of it as a universal adapter that lets AI models like Claude interact with your applications in a secure, structured way. Instead of manually copying data between your feed reader and your AI assistant, MCP enables direct, programmatic access.</p>

    <p>Lion Reader&rsquo;s MCP server is built with the official <a href="https://github.com/modelcontextprotocol/typescript-sdk" target="_blank" rel="noopener noreferrer">MCP TypeScript SDK</a> and supports two transports. Remote assistants such as <a href="https://claude.ai/" target="_blank" rel="noopener noreferrer">claude.ai</a> connect to the deployed app over <strong>Streamable HTTP</strong>, authenticating with <a href="https://oauth.net/2.1/" target="_blank" rel="noopener noreferrer">OAuth 2.1</a> access tokens (or scoped API tokens). Local assistants such as <a href="https://claude.ai/download" target="_blank" rel="noopener noreferrer">Claude Desktop</a> connect over <strong>stdio</strong>, keeping the connection entirely on your machine. Both transports register the same tools and call the same services layer.</p>

    <h3>Available Tools</h3>

    <p>The Lion Reader MCP server exposes a comprehensive set of tools that mirror the web UI&rsquo;s capabilities:</p>

    <ul>
      <li><strong>list_entries</strong> &mdash; List feed entries with filters, search, and pagination</li>
      <li><strong>get_entry</strong> &mdash; Get a single entry with full content</li>
      <li><strong>mark_entries_read</strong> &mdash; Mark entries as read or unread in bulk</li>
      <li><strong>star_entries</strong> &mdash; Star or unstar entries</li>
      <li><strong>count_entries</strong> &mdash; Get entry counts with filters</li>
      <li><strong>save_article</strong> &mdash; Save a URL for later reading</li>
      <li><strong>delete_saved_article</strong> &mdash; Remove a saved article</li>
      <li><strong>upload_article</strong> &mdash; Upload Markdown content as an article</li>
      <li><strong>list_subscriptions</strong> &mdash; List and search active subscriptions</li>
      <li><strong>get_subscription</strong> &mdash; Get subscription details</li>
      <li><strong>list_tags</strong> &mdash; List tags with feed and unread counts</li>
      <li><strong>create_tag</strong> &mdash; Create a new tag</li>
      <li><strong>update_tag</strong> &mdash; Update a tag&rsquo;s name or color</li>
      <li><strong>delete_tag</strong> &mdash; Delete a tag</li>
    </ul>

    <h3>Consistent Behavior</h3>

    <p>The MCP server uses the same services layer as the web UI, ensuring behavior is identical across interfaces. Whether you&rsquo;re reading entries through your browser or asking Claude to <a href="/demo/all?entry=ai-summaries">summarize them</a>, you&rsquo;re accessing the same underlying data with the same permissions and filters.</p>

    <h3>Security and Usage</h3>

    <p>Remote access uses OAuth 2.1 access tokens carrying the <code>mcp</code> scope and audience-bound to the MCP endpoint, so a token minted for another service can&rsquo;t be replayed here; scoped API tokens work too. Connect an OAuth client like claude.ai, or generate an API token with the <code>mcp</code> scope from your account settings. To run a local server for Claude Desktop and other stdio clients, use <code>pnpm mcp:serve</code> and point your assistant at it.</p>
  `,
};

export default article;
