import { type DemoArticle } from "./types";
import heroImage from "./images/search.png";
import ogImage from "./images/search-og.png";

const article: DemoArticle = {
  id: "search",
  subscriptionId: "organization",
  type: "web",
  url: null,
  title: "Full-Text Search",
  author: null,
  summary:
    "Find any article in your archive by searching its title or text, with the closest matches shown first and search that works alongside your usual filters.",
  publishedAt: new Date("2025-12-28T10:00:00Z"),
  starred: false,
  heroImage,
  ogImage,
  heroImageAlt:
    "The Lion Reader lion peering through a large magnifying glass at a floating article card.",
  summaryHtml: `<p>Lion Reader&rsquo;s <strong>full-text search</strong> finds any article across your whole archive by its title or its text, with the most relevant matches shown first. Search works alongside your existing filters &mdash; a subscription, a tag, starred, or unread &mdash; and understands word variations, so &ldquo;running&rdquo; also finds &ldquo;run.&rdquo;</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-07-18"),
  contentHtml: `
    <h2>Find Anything, Instantly</h2>

    <p>Press <strong>/</strong> or tap the search icon and start typing. Lion Reader searches every article in your archive &mdash; matching both the <strong>title</strong> and the <strong>full text</strong> &mdash; so you can track something down whether you remember the headline or just a phrase from the middle of the piece. The closest matches come back first, so what you&rsquo;re looking for is usually right at the top.</p>

    <p>Search understands word variations, so you don&rsquo;t have to guess the exact wording: a search for <em>&ldquo;cook&rdquo;</em> also turns up <em>&ldquo;cooking&rdquo;</em> and <em>&ldquo;cooked.&rdquo;</em> Results keep loading as you scroll, no matter how large your archive gets.</p>

    <h3>Searches Where You Already Are</h3>

    <p>Search doesn&rsquo;t throw away the view you&rsquo;re in &mdash; it narrows it. Searching from inside a single subscription, a <a href="/demo/all?entry=tags">tag</a>, your <a href="/demo/all?entry=save-for-later">saved articles</a>, or your starred items keeps that scope, so you can look <em>within</em> a specific <a href="/demo/all?entry=email-newsletters">newsletter</a> instead of across everything. And because search normally covers read articles too, it&rsquo;s just as good for digging up something from months ago as for finding today&rsquo;s unread items.</p>

    <p>Wherever you read Lion Reader, you can search: the web app on your phone or desktop, and through connected tools like AI assistants via the <a href="/demo/all?entry=mcp-server">MCP server</a>.</p>
  `,
};

export default article;
