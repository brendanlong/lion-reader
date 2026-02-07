import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "ai-summaries",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "AI Summaries",
  author: null,
  summary: "Generate concise AI summaries to quickly triage your reading list.",
  publishedAt: new Date("2026-01-16T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader&#39;s AI summarization feature helps you triage unread articles by generating concise overviews only when requested. <strong>Key features:</strong></p>
<ul>
<li><strong>Privacy-first approach</strong>: Summaries are generated on-demand when you click &quot;Summarize,&quot; not automatically, avoiding unnecessary API costs and data sharing</li>
<li><strong>2-3 paragraph overviews</strong> powered by Anthropic Claude that highlight main topics, key findings, and conclusions</li>
<li><strong>Intelligent caching</strong>: Summaries are cached by content hash and shared across users, providing instant results for previously summarized articles</li>
<li><strong>Configurable models</strong>: Choose between quality and speed based on your preferences</li>
<li><strong>Full content support</strong>: Works with both feed excerpts and full-fetched articles, ensuring complete context</li>
</ul>
<p>Particularly useful for working through large backlogs—scan summaries to identify must-reads versus skippable content, then focus your attention on what matters most.</p>`,
  contentHtml: `
    <h2>AI Summaries</h2>

    <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? AI summaries help you triage your reading list by generating concise overviews on demand, letting you quickly decide what deserves your full attention.</p>

    <h3>Privacy-Respecting Design</h3>

    <p>Unlike some readers that automatically summarize everything (consuming API credits and sharing your reading habits), Lion Reader only generates summaries when you explicitly request them. Click the &ldquo;Summarize&rdquo; button in the article header, and <a href="https://www.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic Claude</a> generates a 2&ndash;3 paragraph overview focusing on the main topic, key findings, and important conclusions.</p>

    <p>The summary appears in a collapsible card above the article content. You can expand or collapse it as needed, or dismiss it entirely if you decide to read the full article instead.</p>

    <h3>Efficient Caching</h3>

    <p>Summaries are cached by content hash and shared across all users. If someone else already summarized an article, you get the cached result instantly &mdash; no API call required. This aggressive caching dramatically reduces costs while speeding up response times. You can configure your preferred summarization model in settings, balancing quality and speed based on your needs.</p>

    <h3>Works Everywhere</h3>

    <p>Summaries work with both feed content and full-fetched content. If a feed only provides an excerpt, fetch the full article first, then summarize &mdash; ensuring you get a summary of the complete text, not just the preview. The feature gracefully degrades when the AI service is unavailable, displaying a clear error message rather than leaving you wondering what happened.</p>

    <p>Great for working through a large backlog: quickly scan summaries to separate the must-reads from the can-skip, then dive deep into the articles that matter most to you.</p>
  `,
};

export default article;
