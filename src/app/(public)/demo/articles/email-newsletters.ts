import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "email-newsletters",
  subscriptionId: "feed-types",
  type: "email",
  url: "https://github.com/brendanlong/lion-reader/pull/47",
  title: "Email Newsletters",
  author: null,
  summary:
    "Get a private email address for newsletters, and read them in Lion Reader instead of in your inbox.",
  publishedAt: new Date("2025-12-30T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader gives you a private email address so newsletters land in your reader instead of your inbox, with each sender becoming its own subscription that gets starring, tags, search, and summaries like any other article. Unsubscribing blocks the sender and, where supported, removes you from its mailing list too.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lots of great writing only arrives by email. Lion Reader gives you a private address to subscribe with, so newsletters land in your reader next to everything else you follow and save, instead of burying your inbox. Each sender becomes its own subscription automatically, and its issues get everything any other article does: starring, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=ai-summaries">summaries</a>, and <a href="/demo/all?entry=text-to-speech">listening</a>.</p>

    <h3>Getting Started</h3>

    <p>Create an address in Settings and use it anywhere a newsletter asks for your email. For newsletters you already get, change your email in your account settings on each newsletter&rsquo;s website. Confirmation emails show up in Lion Reader like any other issue, so you can confirm from there; if the button is missing, press <strong>Show Original</strong> at the top of the email. Forwarding from your old inbox doesn&rsquo;t work, since every issue would arrive from you instead of the newsletter.</p>

    <p>You can make more than one address &mdash; label each one so you remember where you used it &mdash; and delete any address that starts attracting spam. Issues you&rsquo;ve already received stay put, and only you can see them (more in <a href="/demo/all?entry=auth-security">Privacy &amp; Security</a>).</p>

    <h3>Unsubscribing and Blocking Senders</h3>

    <p>Unsubscribe from a newsletter and Lion Reader blocks that sender, so their mail stops showing up &mdash; and for newsletters that support one-click unsubscribe, as most big newsletter platforms do, it takes you off the mailing list too, with no hunting for the tiny link at the bottom of the email. Past issues are hidden, except ones you starred. Changed your mind? Unblock the sender in Settings.</p>
  `,
};

export default article;
