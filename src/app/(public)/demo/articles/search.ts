import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "search",
  subscriptionId: "organization",
  type: "web",
  url: null,
  title: "Full-Text Search",
  author: null,
  summary:
    "Find any article you've ever had by a word from its title or text, closest matches first, within whatever list you're looking at.",
  publishedAt: new Date("2025-12-28T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Pressing <strong>/</strong> searches the title and full text of everything in your reader, including sites you follow, newsletters, and saved articles already read, with the closest matches first and support for word variations like &ldquo;cook&rdquo; and &ldquo;cooking.&rdquo; Searching from inside a subscription, tag, or saved articles narrows results.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Press <strong>/</strong> or tap the search icon and start typing. Lion Reader searches everything in your reader &mdash; the sites you follow, your <a href="/demo/all?entry=email-newsletters">newsletters</a>, and your <a href="/demo/all?entry=save-for-later">saved articles</a> &mdash; matching both the <strong>title</strong> and the <strong>full text</strong>, so you can track something down whether you remember the headline or just a phrase from the middle of the piece. The closest matches come back first.</p>

    <p>Search understands word variations, so you don&rsquo;t have to guess the exact wording: a search for <em>&ldquo;cook&rdquo;</em> also turns up <em>&ldquo;cooking&rdquo;</em> and <em>&ldquo;cooked.&rdquo;</em> And because it includes articles you&rsquo;ve already read, it&rsquo;s just as good for digging up something from months ago as for finding today&rsquo;s unread items.</p>

    <h3>Search Within a Newsletter, Tag, or Your Saved Articles</h3>

    <p>Search narrows the view you&rsquo;re in instead of replacing it. Searching from inside a single subscription, a <a href="/demo/all?entry=tags">tag</a>, your saved articles, or your starred items keeps that scope, so you can look within one newsletter instead of across everything.</p>

    <p>Can&rsquo;t think of the right words? Ask your <a href="/demo/all?entry=mcp-server">AI assistant</a> to &ldquo;find the article I read last month about sourdough starters.&rdquo;</p>
  `,
};

export default article;
