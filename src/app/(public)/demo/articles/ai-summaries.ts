import { type DemoArticle } from "./types";
import heroImage from "./images/ai-summaries.png";
import ogImage from "./images/ai-summaries-og.png";

const article: DemoArticle = {
  id: "ai-summaries",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/298",
  title: "AI Summaries",
  author: null,
  summary: "Generate concise AI summaries to quickly triage your reading list.",
  publishedAt: new Date("2026-01-16T12:00:00Z"),
  starred: true,
  heroImage,
  ogImage,
  heroImageAlt:
    "The Lion Reader lion waving a sparkling magic wand to condense a long scroll into a short summary card.",
  summaryHtml: `<p>Lion Reader offers <strong>on-demand AI summaries</strong> to help triage unread articles. Unlike auto-summarizing readers, summaries are only generated when you click &quot;Summarize.&quot; Results are <strong>cached and shared across users</strong> to reduce costs, letting you quickly scan summaries to prioritize your reading list.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
  contentHtml: `
    <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? AI summaries help you triage your reading list by generating concise overviews on demand, letting you quickly decide what deserves your full attention.</p>

    <h3>Privacy-Respecting Design</h3>

    <p>Unlike some readers that automatically summarize everything (consuming API credits and sharing your reading habits), Lion Reader only generates summaries when you explicitly request them. Click the &ldquo;Summarize&rdquo; button in the article header, and your chosen model generates a concise overview focusing on the main topic, key findings, and important conclusions.</p>

    <p>The summary appears in a collapsible card above the article content. You can expand or collapse it as needed, or dismiss it entirely if you decide to read the full article instead.</p>

    <h3>Bring Your Own Model</h3>

    <p>Add an API key under Settings &rarr; AI &amp; Narration and pick any model from <a href="https://groq.com/" target="_blank" rel="noopener noreferrer">Groq</a>, <a href="https://www.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic</a>, or <a href="https://www.cerebras.ai/" target="_blank" rel="noopener noreferrer">Cerebras</a>. For most people we recommend <a href="https://openai.com/index/introducing-gpt-oss/" target="_blank" rel="noopener noreferrer">GPT-OSS-120B</a> on Cerebras &mdash; summaries come back near-instantly at roughly a tenth of the price of Claude Sonnet &mdash; but Anthropic&rsquo;s Claude models are there when you want the sharpest possible summary.</p>

    <h3>Efficient Caching</h3>

    <p>Summaries are cached by content hash and shared across all users. If someone else already summarized an article, you get the cached result instantly &mdash; no API call required. This aggressive caching dramatically reduces costs while speeding up response times.</p>

    <h3>Works Everywhere</h3>

    <p>Summaries work with both feed content and full-fetched content. If a feed only provides an excerpt, <a href="/demo/all?entry=full-content">fetch the full article</a> first, then summarize &mdash; ensuring you get a summary of the complete text, not just the preview. The feature gracefully degrades when the AI service is unavailable, displaying a clear error message rather than leaving you wondering what happened.</p>

    <p>Great for working through a large backlog: quickly scan summaries to separate the must-reads from the can-skip, then dive deep into the articles that matter most to you.</p>
  `,
};

export default article;
