import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "email-newsletters",
  subscriptionId: "feed-types",
  type: "email",
  url: "https://github.com/brendanlong/lion-reader/pull/47",
  title: "Email Newsletters",
  author: null,
  summary: "Read newsletters alongside your feeds with unique ingest email addresses.",
  publishedAt: new Date("2025-12-30T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader solves the problem of email-only content by allowing users to <strong>create unique ingest email addresses</strong> (up to 5 per account) for subscribing to newsletters. Each newsletter sender automatically becomes a separate subscription in your feed reader.</p>
<p><strong>Key features:</strong></p>
<ul>
<li>Subscribe to any email newsletter using generated addresses</li>
<li>Newsletters are processed via Mailgun webhook integration and appear as regular feed entries</li>
<li>Full feature parity with RSS feeds: starring, read/unread status, search, and tagging</li>
<li>Label addresses for organization (e.g., &quot;Tech Newsletters&quot;)</li>
</ul>
<p><strong>Security measures:</strong></p>
<ul>
<li>HMAC signature verification ensures email authenticity</li>
<li>Message-ID deduplication prevents duplicates</li>
<li>Provider-level spam filtering</li>
<li>Ability to block specific senders</li>
<li>Supports List-Unsubscribe headers for one-click unsubscribe</li>
</ul>
<p>Email newsletters are treated as first-class subscriptions, unifying email and web content in a single timeline.</p>`,
  contentHtml: `
    <h2>Email Newsletters: Bring Inbox Content to Your Feed Reader</h2>

    <p>Many exceptional writers and publications distribute content exclusively via email newsletters, not RSS feeds. Substack, Ghost, Buttondown, and countless independent creators have chosen email as their primary distribution channel. Lion Reader solves this problem by generating unique ingest email addresses &mdash; up to 5 per account &mdash; that you can use to subscribe to any newsletter. Each newsletter sender automatically becomes its own subscription in your Lion Reader account, appearing alongside your web feeds in a unified timeline.</p>

    <h3>How It Works</h3>

    <p>When you create an ingest address, you can label it for organization (e.g., &ldquo;Tech Newsletters&rdquo; or &ldquo;Personal&rdquo;). Subscribe to newsletters using this address just like you would with your regular email. When newsletters arrive, Lion Reader processes them via Mailgun webhook integration, verifies HMAC signatures for security, deduplicates by Message-ID, and converts the content into regular feed entries with a full reading experience. You can star entries, mark them read, search across content, and organize them with tags &mdash; everything you can do with RSS feeds.</p>

    <h3>Security &amp; Spam Protection</h3>

    <p>Ingest addresses include built-in security measures: HMAC signature verification ensures emails are genuinely from the mail provider, Message-ID deduplication prevents duplicates, and provider-level spam filtering blocks junk before it reaches your feed. You can block specific senders at any time, and Lion Reader respects List-Unsubscribe headers for one-click unsubscribe functionality when newsletters support it.</p>

    <p>Email newsletters in Lion Reader are treated as first-class subscriptions &mdash; they appear in your timeline, support all the same reading features as RSS feeds, and can be organized with the same tools. No more switching between your email client and feed reader to keep up with your favorite writers.</p>
  `,
};

export default article;
