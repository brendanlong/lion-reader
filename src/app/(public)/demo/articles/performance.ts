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
  summaryHtml: `<p>Lion Reader treats speed as a feature: new articles appear in your list automatically with no refresh, previously visited lists open instantly, and marking something read or starred takes effect the moment you tap, syncing across devices. It stays fast as your library grows, with page loads under 100 milliseconds.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader treats speed as a feature you can feel. Try it here: jump between lists in the sidebar, or press <kbd>j</kbd> to move through articles.</p>

    <h3>New Articles Appear on Their Own</h3>

    <p>When Lion Reader picks up a new article, it appears in your list automatically &mdash; no refresh, no &ldquo;load more&rdquo; button. It slides into the right spot by date, and the article you&rsquo;re reading stays open. Articles you read or star on another device update the same way, and so do new subscriptions, <a href="/demo/all?entry=email-newsletters">newsletters</a>, <a href="/demo/all?entry=save-for-later">saved articles</a>, and <a href="/demo/all?entry=opml">imports</a>.</p>

    <h3>Instant Navigation</h3>

    <p>Lists you&rsquo;ve already visited &mdash; a subscription, a tag, your saved articles &mdash; open instantly and catch up quietly in the background. Opening an article keeps the list where it was, so closing it puts you right back where you left off.</p>

    <h3>Every Tap Takes Effect Immediately</h3>

    <p>Marking an article read or starring it takes effect the moment you tap or press the key, without waiting on the server, and shows up on your other devices right away.</p>

    <h3>Stays Fast as Your Library Grows</h3>

    <p>Lion Reader stays fast no matter how many articles pile up in your account. Typical page loads take under 100ms, even on an inexpensive server.</p>

    <details>
      <summary>How it stays fast</summary>
      <ul>
        <li>Lists are built so that loading the next page takes the same time whether you have a hundred articles or a million.</li>
        <li>Each article is prepared for reading when it&rsquo;s first fetched, so opening it later is quick.</li>
        <li>A feed is fetched once and shared by everyone subscribed to it, while each person&rsquo;s reading stays private.</li>
        <li>Updates send only what changed, so the app can patch the article in place instead of reloading the list.</li>
        <li>If you make conflicting changes on two devices, the most recent one wins, so every device ends up the same.</li>
      </ul>
    </details>
  `,
};

export default article;
