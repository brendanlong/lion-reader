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
  summaryHtml: `<p>Connect Lion Reader to Claude or another <strong>AI assistant</strong> using the Model Context Protocol, and it can read, search, star, save, and mark articles read, look up subscriptions, or edit tags, with the same results as doing it yourself. Its access is limited to your reader and can be revoked anytime.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Connect Lion Reader to Claude or another AI assistant, and it can work with your reading list the way you would. Just ask:</p>

    <ul>
      <li>&ldquo;What did my favorite blogs post this week? Summarize anything about climate policy.&rdquo;</li>
      <li>&ldquo;Find the article I read last month about sourdough starters.&rdquo;</li>
      <li>&ldquo;Mark everything older than a week in my News tag as read.&rdquo;</li>
      <li>&ldquo;Save this link for me to read later.&rdquo;</li>
      <li>&ldquo;Write up these meeting notes and put them in my reading list.&rdquo;</li>
    </ul>

    <p>Your assistant can read, search, star, and save articles, mark things read, look up your subscriptions, and create and edit your tags &mdash; with the same results you&rsquo;d get doing it yourself in the app.</p>

    <h3>Connecting</h3>

    <p>Lion Reader uses the <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a>, the open standard for plugging tools into AI assistants. Settings has copy-and-paste setup steps for Claude, and any other assistant that supports MCP can connect the same way.</p>

    <p>You stay in control of what an assistant can reach: its access is limited to your reader, and you can revoke it at any time from Settings.</p>
  `,
};

export default article;
