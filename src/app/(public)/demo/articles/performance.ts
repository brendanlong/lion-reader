import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "performance",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "Obsessive Performance",
  author: null,
  summary:
    "New articles appear in your lists without a refresh, moving around is instant, and typical pages load in under 100ms.",
  publishedAt: new Date("2026-03-01T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader is built for <strong>speed you can feel</strong>: new articles slide into your list automatically without a refresh, previously opened views load instantly, and marking an article read or starred takes effect immediately. Typical page loads land under 100ms, staying fast no matter how many articles pile up.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Most of Lion Reader&rsquo;s features exist in other readers somewhere. What&rsquo;s harder to find is a reader that treats <em>speed</em> as a feature you can feel. Lion Reader is built so the interface stays out of your way.</p>

    <h3>New Articles Appear on Their Own</h3>

    <p>When a new article is published, it appears in your list automatically &mdash; no refresh, no &ldquo;load more&rdquo; button. It slides into the right spot by date, and the article you&rsquo;re reading stays open. Articles you read or star on another device update the same way, and so do new subscriptions and <a href="/demo/all?entry=opml">imports</a>.</p>

    <h3>Instant Navigation</h3>

    <p>Anything you&rsquo;ve already opened &mdash; a subscription, a tag, your saved articles &mdash; comes back instantly from what&rsquo;s already loaded, then quietly refreshes in the background. Opening something new loads just that content; the rest of the app, including your place in the current list, stays put.</p>

    <h3>No Waiting on the Server</h3>

    <p>Marking an article read or starring it takes effect the moment you press the key. If you make conflicting changes on two devices, Lion Reader keeps the most recent one, so everything stays in sync.</p>

    <h3>Fast on Cheap Hardware</h3>

    <p>Typical page loads land under 100ms on inexpensive cloud servers, and stay fast no matter how many articles pile up in your account.</p>

    <details>
      <summary>How it stays fast</summary>
      <ul>
        <li>Lists are built so that loading the next page takes the same time whether you have a hundred articles or a million.</li>
        <li>The readable version of each article is extracted once, when it&rsquo;s first fetched, not every time you open it.</li>
        <li>A feed is fetched once and shared by everyone subscribed to it, while each person&rsquo;s reading stays private.</li>
        <li>Updates send only what changed, so the app can patch the article in place instead of reloading the list.</li>
      </ul>
    </details>
  `,
};

export default article;
