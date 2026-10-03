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
  summaryHtml: `<p>Lion Reader treats speed as a feature you can feel: <strong>new articles appear in your lists automatically</strong> without a refresh, moving around the app is instant and never reloads what you&rsquo;re reading, your own actions apply the moment you make them, and a carefully tuned backend keeps typical page loads under 100ms.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-07-03"),
  contentHtml: `
    <p>Most of Lion Reader&rsquo;s features exist in other readers somewhere. What&rsquo;s harder to find is a reader that treats <em>speed</em> as a feature you can feel. Lion Reader is built so the interface stays out of your way.</p>

    <h3>New articles, without the jank</h3>

    <p>When a new article is published, it appears in your list automatically &mdash; no refresh, no &ldquo;load more&rdquo; button. It slides into the right spot by date, and if you&rsquo;re partway down a list, your scroll position and the article you&rsquo;re reading stay exactly where they are. Articles you read or star on another device update the same way, and so do new subscriptions and <a href="/demo/all?entry=opml">imports</a>.</p>

    <h3>Instant navigation</h3>

    <p>Anything you&rsquo;ve already opened &mdash; a subscription, a tag, your saved articles &mdash; comes back instantly with nothing to reload. Opening something new loads just that content; the rest of the app, including your place in the current list, stays put.</p>

    <h3>No waiting on the server</h3>

    <p>Marking an article read or starring it takes effect the moment you press the key. If you make conflicting changes on two devices, Lion Reader keeps the most recent one, so everything stays in sync.</p>

    <h3>Fast on cheap hardware</h3>

    <p>Typical page loads land under 100ms on inexpensive cloud servers, and stay fast no matter how many articles pile up in your account.</p>

    <details>
      <summary>How it stays fast</summary>
      <ul>
        <li>Lists are built so that loading the next page takes the same time whether you have a hundred articles or a million.</li>
        <li>Articles are cleaned up and formatted once, when they&rsquo;re first fetched, not every time you open them.</li>
        <li>A feed is fetched once and shared by everyone subscribed to it, while each person&rsquo;s reading stays private.</li>
        <li>Updates send only what changed, so the app can patch the article in place instead of reloading the list.</li>
      </ul>
    </details>
  `,
};

export default article;
