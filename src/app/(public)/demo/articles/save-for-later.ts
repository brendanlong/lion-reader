import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "save-for-later",
  subscriptionId: "feed-types",
  type: "saved",
  url: "https://github.com/brendanlong/lion-reader/pull/57",
  title: "Save for Later",
  author: null,
  summary:
    "Save any page to read later, from wherever you find it. Lion Reader keeps a clean, readable copy that won't disappear.",
  publishedAt: new Date("2025-12-27T16:00:00Z"),
  starred: true,
  summaryHtml: `<p>Lion Reader&#39;s Save for Later uses Mozilla&#39;s Readability algorithm to extract clean content from web pages. Save via bookmarklet, PWA share, MCP, API, Discord, or upload Markdown/Word/HTML files directly. Saved articles integrate fully with starring, tagging, and search, preserving content even if original pages disappear.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
  contentHtml: `
    <p>Found something you want to read later? Save it to Lion Reader and you get a clean, readable copy &mdash; no ads, no pop-ups, no sidebar clutter &mdash; waiting next to your feeds. Lion Reader keeps its own copy, so the article stays readable even if the original page changes or disappears.</p>

    <h3>Save From Anywhere</h3>

    <p>Saving should take one tap wherever you happen to be reading:</p>

    <ul>
      <li><strong>In your browser</strong> &mdash; with the <a href="/demo/all?entry=browser-extension">browser extension</a> or a bookmarklet</li>
      <li><strong>On your phone</strong> &mdash; from the share menu, via the <a href="/demo/all?entry=pwa">installed app</a> or the <a href="/demo/all?entry=wallabag-api">Wallabag app</a></li>
      <li><strong>In a chat</strong> &mdash; by reacting to a link with the <a href="/demo/all?entry=discord-bot">Discord bot</a></li>
      <li><strong>By asking</strong> &mdash; tell your <a href="/demo/all?entry=mcp-server">AI assistant</a> to save it for you</li>
      <li><strong>From a file</strong> &mdash; <a href="/demo/all?entry=file-upload">upload</a> a Word document, Markdown, or other document</li>
    </ul>

    <p>Or just paste a link into Lion Reader itself.</p>

    <h3>Better Copies of Tricky Pages</h3>

    <p>Some sites don&rsquo;t save well the usual way &mdash; a video page, a GitHub repository, a paper on arXiv, a Google Doc. Lion Reader recognizes many of these and brings in the real content instead of a stripped-down page. See <a href="/demo/all?entry=plugins">smart content sources</a> for more.</p>

    <h3>Part of Your Library</h3>

    <p>Saved articles get their own section in the sidebar, but they work like everything else: star them, <a href="/demo/all?entry=tags">tag</a> them, <a href="/demo/all?entry=search">search</a> them, <a href="/demo/all?entry=text-to-speech">listen</a> to them, or <a href="/demo/all?entry=ai-summaries">summarize</a> them.</p>
  `,
};

export default article;
