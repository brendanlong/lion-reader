import { type DemoArticle } from "./types";
import { resolveWelcomePublishedAt } from "./welcome-published-at";

const article: DemoArticle = {
  id: "welcome",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Welcome to Lion Reader",
  author: null,
  summary:
    "An AI-native, all-in-one reader for feeds, newsletters, and read-later. Explore the demo to see what it can do.",
  // Build/deploy-stamped so SSR and the post-hydration client render show the
  // identical time (no "31 minutes ago" → "just now" jump). See
  // resolveWelcomePublishedAt for the full rationale.
  publishedAt: resolveWelcomePublishedAt(process.env.NEXT_PUBLIC_BUILD_TIME),
  starred: true,
  summaryHtml: `<p>Lion Reader is a <strong>self-hostable feed reader</strong> that brings your feeds, newsletters, and saved articles into one fast interface built to work with AI assistants. Ask an AI assistant to search or save articles for you, summarize anything in seconds, and listen in a natural voice. It&rsquo;s free, open source, and never tracks what you read.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Lion Reader is a self-hostable feed reader for people who take their reading seriously. It brings your feeds, your newsletters, and everything you save for later into one fast, elegant interface &mdash; and it&rsquo;s built from the ground up to work with AI assistants.</p>

    <p>This interactive demo is the real Lion Reader UI. Browse the sidebar to explore each capability &mdash; the <a href="/demo/starred">Starred</a> list is a good place to start.</p>

    <h3>What makes it different</h3>

    <ul>
      <li><strong>AI-native, not AI-bolted-on</strong> &mdash; <a href="/demo/all?entry=mcp-server">Ask Claude or another AI assistant</a> to search, triage, and save articles for you. <a href="/demo/all?entry=ai-summaries">Summarize</a> any article in seconds, and <a href="/demo/all?entry=text-to-speech">listen</a> to anything in a natural voice while it highlights along.</li>
      <li><strong>Everything in one place</strong> &mdash; <a href="/demo/all?entry=rss-atom">Follow any website</a>, read <a href="/demo/all?entry=email-newsletters">email newsletters</a> without cluttering your inbox, and <a href="/demo/all?entry=save-for-later">save anything for later</a> from your browser, your phone, Discord, or a file. Links from places like YouTube, arXiv, and GitHub <a href="/demo/all?entry=plugins">come through complete and readable</a>.</li>
      <li><a href="/demo/all?entry=performance"><strong>Obsessively fast</strong></a> &mdash; New articles show up in the list you&rsquo;re reading without a refresh, and moving around the app is instant.</li>
      <li><strong>All the essentials, done well</strong> &mdash; <a href="/demo/all?entry=full-content">Full articles from excerpt-only feeds</a>, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=keyboard-shortcuts">keyboard shortcuts</a>, <a href="/demo/all?entry=opml">easy import and export</a>, <a href="/demo/all?entry=pwa">install it like an app</a>, and <a href="/demo/all?entry=appearance">themes</a> for day, night, and e-ink.</li>
      <li><strong>Yours to own</strong> &mdash; Free and <a href="/demo/all?entry=open-source">open source</a>, and you can run your own copy. No ads, no data selling, and no tracking of what you read.</li>
    </ul>

    <p>Lion Reader is designed and built by <a href="https://www.brendanlong.com/pages/about-me.html" target="_blank" rel="noopener noreferrer">Brendan Long</a>.</p>

    <p>Ready to take control of your reading? Sign up to start using the full app, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">check out the source code on GitHub</a> to self-host your own instance.</p>
  `,
};

export default article;
