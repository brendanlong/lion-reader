import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "mcp-server",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/285",
  title: "Use Lion Reader from Your AI Assistant",
  author: null,
  summary:
    "Connect Claude or another AI assistant to your reader and ask it to find, triage, organize, and save articles for you.",
  publishedAt: new Date("2026-01-14T12:00:00Z"),
  starred: true,
  summaryHtml: `<p>Connecting Lion Reader to Claude or another MCP-compatible assistant lets it read, search, star, save, and mark articles, and manage tags, with the same results as using the app yourself. Access is limited to your reader and revocable, and any articles it looks up are shared with the assistant&rsquo;s provider.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Connect Lion Reader to Claude or another AI assistant, and it can work with your reading the way you would. Just ask:</p>

    <ul>
      <li>&ldquo;What did the blogs in my News tag post this week? Summarize anything about climate policy.&rdquo;</li>
      <li>&ldquo;Give me a rundown of today&rsquo;s newsletters.&rdquo;</li>
      <li>&ldquo;Which of my unread articles are worth reading today?&rdquo;</li>
      <li>&ldquo;Save this link for me to read later.&rdquo;</li>
    </ul>

    <p>Your assistant can read, search, star, and save articles, mark things read, look up your subscriptions, and create and edit your tags &mdash; with the same results you&rsquo;d get doing it yourself in the app.</p>

    <h3>Connecting</h3>

    <p>Settings has copy-and-paste setup steps for Claude on the web, on desktop, and in Claude Code. Other assistants that support the <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a>, the open standard for plugging tools into AI assistants, can connect the same way.</p>

    <p>You stay in control of what an assistant can reach: its access is limited to your reader, and you can revoke it at any time from Settings. The articles it looks up are shared with your assistant&rsquo;s provider, the same as anything else you show it.</p>
  `,
};

export default article;
