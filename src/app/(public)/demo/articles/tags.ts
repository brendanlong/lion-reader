import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "tags",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/92",
  title: "Tags",
  author: null,
  summary:
    "Group your subscriptions with color-coded tags, read one topic at a time, and rename anything to suit you.",
  publishedAt: new Date("2025-12-27T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Group the sites and newsletters you follow using colored <strong>tags</strong>, with a subscription able to belong to several at once; untagged subscriptions appear under &ldquo;Uncategorized.&rdquo; Each tag shows its own unread count in the sidebar, and importing from another reader turns folders into tags automatically. Subscriptions can be renamed anytime.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Group your subscriptions with tags &mdash; &ldquo;News,&rdquo; &ldquo;Friends,&rdquo; &ldquo;Work&rdquo; &mdash; and give each one a color. A subscription can have as many tags as you like, so a blog about cooking and travel can live in both places. Tags work the same for the <a href="/demo/all?entry=rss-atom">sites you follow</a> and your <a href="/demo/all?entry=email-newsletters">newsletters</a>.</p>

    <p>Each tag shows up in the sidebar with its own unread count, so you can read one topic at a time &mdash; &ldquo;Features&rdquo; and &ldquo;About&rdquo; in this demo&rsquo;s sidebar are tags. Subscriptions you haven&rsquo;t tagged appear under &ldquo;Uncategorized,&rdquo; so nothing gets lost.</p>

    <p>To tag a subscription, click the pencil icon next to it in the sidebar. <a href="/demo/all?entry=save-for-later">Saved articles</a> have their own section instead of tags. If you <a href="/demo/all?entry=opml">import from another reader</a>, your folders become tags automatically.</p>

    <h3>Rename Subscriptions</h3>

    <p>Rename any subscription to whatever you&rsquo;ll recognize &mdash; handy for newsletters with long names or feeds you think of differently.</p>
  `,
};

export default article;
