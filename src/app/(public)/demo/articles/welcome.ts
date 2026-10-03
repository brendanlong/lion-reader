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
    "One fast, private reader for the sites you follow, your newsletters, and articles you save for later. Free to use and open source.",
  // Build/deploy-stamped so SSR and the post-hydration client render show the
  // identical time (no "31 minutes ago" → "just now" jump). See
  // resolveWelcomePublishedAt for the full rationale.
  publishedAt: resolveWelcomePublishedAt(process.env.NEXT_PUBLIC_BUILD_TIME),
  starred: true,
  summaryHtml: `<p>Lion Reader brings the sites you follow, your email newsletters, and articles you save for later into one fast, private reader that&rsquo;s free, open source, and works with your existing RSS apps and AI assistants. It runs with no ads, no data selling, and no tracking of what you read.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader brings the sites you follow, your email newsletters, and the articles you save for later into one fast, private reader. Newsletters arrive at a private address you subscribe with, so it never needs access to your inbox. It&rsquo;s free to use, open source, and works on your phone and computer.</p>

    <p>This interactive demo is the real Lion Reader UI, and each article in it covers one feature. Many you can try right here: summarize or listen to any article, switch the theme, or press <kbd>?</kbd> to see the keyboard shortcuts.</p>

    <h3>What makes it different</h3>

    <ul>
      <li><strong>Everything in one place</strong> &mdash; <a href="/demo/all?entry=rss-atom">Follow your favorite sites</a>, read <a href="/demo/all?entry=email-newsletters">email newsletters</a> without cluttering your inbox, and <a href="/demo/all?entry=save-for-later">save anything for later</a> from your browser, your phone, Discord, or a file. Links from places like YouTube, arXiv, and GitHub <a href="/demo/all?entry=plugins">come through complete and readable</a>.</li>
      <li><strong>Yours to own</strong> &mdash; Free to use and <a href="/demo/all?entry=open-source">open source</a>, so you can run your own copy. No ads, no data selling, and no tracking of what you read. <a href="/demo/all?entry=opml">Bring your subscriptions</a> from another reader, and keep reading in <a href="/demo/all?entry=google-reader-api">your favorite RSS app</a> if you like.</li>
      <li><strong>AI when you want it</strong> &mdash; <a href="/demo/all?entry=ai-summaries">Summarize</a> any article in seconds, <a href="/demo/all?entry=text-to-speech">listen</a> to anything in a natural voice, or <a href="/demo/all?entry=mcp-server">ask Claude or another AI assistant</a> to search, triage, and save articles for you. None of it runs unless you use it.</li>
      <li><a href="/demo/all?entry=performance"><strong>Obsessively fast</strong></a> &mdash; New articles show up in the list you&rsquo;re reading without a refresh, and moving around the app is instant.</li>
      <li><strong>All the essentials, done well</strong> &mdash; <a href="/demo/all?entry=full-content">Full articles even when a site only sends a teaser</a>, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=keyboard-shortcuts">keyboard shortcuts</a>, <a href="/demo/all?entry=pwa">install it like an app</a>, and <a href="/demo/all?entry=appearance">themes</a> for day, night, and e-ink.</li>
    </ul>

    <p>Lion Reader is designed and built by <a href="https://www.brendanlong.com/pages/about-me.html" target="_blank" rel="noopener noreferrer">Brendan Long</a>. Sign up to start using it, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">get the source code on GitHub</a>.</p>
  `,
};

export default article;
