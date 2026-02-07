import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "mcp-server",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/285",
  title: "MCP Server",
  author: null,
  summary: "Connect Lion Reader to AI assistants like Claude via the Model Context Protocol.",
  publishedAt: new Date("2026-01-14T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>The Model Context Protocol (MCP) enables AI assistants like Claude to directly access Lion Reader&#39;s features through a secure local connection. The MCP server exposes tools for reading entries, searching content, managing subscriptions, and marking articles read/starred, using the same services layer as the web UI. Access is controlled via <strong>API tokens with scoped permissions</strong>.</p>`,
  contentHtml: `
    <h2>What is MCP?</h2>

    <p>The <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a> is an open standard for connecting AI assistants to external tools and data sources. Think of it as a universal adapter that lets AI models like Claude interact with your applications in a secure, structured way. Instead of manually copying data between your feed reader and your AI assistant, MCP enables direct, programmatic access.</p>

    <p>Lion Reader&rsquo;s MCP server is built with the official <a href="https://github.com/modelcontextprotocol/typescript-sdk" target="_blank" rel="noopener noreferrer">MCP TypeScript SDK</a> and uses stdio transport for secure local communication. This means the connection stays entirely on your machine &mdash; no data is sent to external servers beyond what your AI assistant already does.</p>

    <h3>Available Tools</h3>

    <p>The Lion Reader MCP server exposes a comprehensive set of tools that mirror the web UI&rsquo;s capabilities:</p>

    <ul>
      <li><strong>list_entries</strong> &mdash; List feed entries with filters and pagination</li>
      <li><strong>search_entries</strong> &mdash; Full-text search across all entries</li>
      <li><strong>get_entry</strong> &mdash; Get a single entry with full content</li>
      <li><strong>mark_entries_read</strong> &mdash; Mark entries as read or unread in bulk</li>
      <li><strong>star_entries</strong> &mdash; Star or unstar entries</li>
      <li><strong>count_entries</strong> &mdash; Get entry counts with filters</li>
      <li><strong>save_article</strong> &mdash; Save a URL for later reading</li>
      <li><strong>delete_saved_article</strong> &mdash; Remove a saved article</li>
      <li><strong>upload_article</strong> &mdash; Upload Markdown content as an article</li>
      <li><strong>list_subscriptions</strong> &mdash; List all active subscriptions</li>
      <li><strong>search_subscriptions</strong> &mdash; Search subscriptions by title</li>
      <li><strong>get_subscription</strong> &mdash; Get subscription details</li>
    </ul>

    <h3>Consistent Behavior</h3>

    <p>The MCP server uses the same services layer as the web UI, ensuring behavior is identical across interfaces. Whether you&rsquo;re reading entries through your browser or asking Claude to summarize them, you&rsquo;re accessing the same underlying data with the same permissions and filters.</p>

    <h3>Security and Usage</h3>

    <p>Access is secured via API tokens with scoped permissions. You can generate tokens from your account settings and configure which operations each token can perform. The server is compatible with Claude Desktop and other MCP-supporting assistants. To run the server locally, use <code>pnpm mcp:serve</code> and configure your AI assistant to connect to it.</p>
  `,
};

export default article;
