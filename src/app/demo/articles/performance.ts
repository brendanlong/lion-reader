import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "performance",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "Obsessive Performance",
  author: null,
  summary:
    "Real-time updates patched straight into the list, instant navigation, and a backend tuned for sub-100ms page loads.",
  publishedAt: new Date("2026-03-01T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader treats speed as a core feature: <strong>real-time updates</strong> patch the UI in-place via Server-Sent Events without refetches, navigation is instant via client-side routing, actions are optimistic, and backend optimizations keep typical page loads under 100ms.</p>`,
  contentHtml: `
    <p>Most of Lion Reader&rsquo;s features exist in other readers somewhere. What&rsquo;s harder to find is a reader that treats <em>speed</em> as a feature you can feel &mdash; not a nice-to-have, but something worth obsessing over. Lion Reader is built so the interface stays out of your way: updates appear without flicker, navigation is instant, and pages load fast even on the cheapest cloud hardware.</p>

    <h3>Real-time updates without the jank</h3>

    <p>When a new article arrives, Lion Reader doesn&rsquo;t refetch your list and re-render it from scratch. The server pushes the entry over the same Server-Sent Events connection that powers live updates, and the client inserts it <strong>directly into the list you&rsquo;re looking at</strong>, in its correct sorted position. Your scroll position is preserved, read entries stay put, and nothing flashes. The same is true for read/unread and starred state: those are patched in place too.</p>

    <p>This is a strict invariant, not an aspiration &mdash; entry lists are marked <code>staleTime: Infinity</code> and are never refetched on a timer or window focus, and end-to-end tests assert that real-time events update the UI with <strong>zero</strong> list refetches. If a change ever slipped a refetch into the hot path, the test suite fails.</p>

    <h3>Navigation with zero server round-trips</h3>

    <p>After the first page load, moving around Lion Reader never hits the server. In-app links use client-side routing and re-derive the view from the URL, serving everything from the React Query cache that real-time updates keep fresh. Opening an entry, switching between a subscription and a tag, jumping to your saved articles &mdash; all of it is instant because the data is already in memory. The cache is the source of truth; the network is just how it&rsquo;s kept up to date.</p>

    <h3>Optimistic by default</h3>

    <p>Actions like marking an entry read or starring it update the UI the instant you press the key, before the server has confirmed anything. If a request ever fails or two devices disagree, per-field timestamps reconcile to the newest intent instead of clobbering state &mdash; so the interface feels immediate without becoming inconsistent.</p>

    <h3>A backend tuned for the hot path</h3>

    <p>The speed you feel in the UI is backed by a database tuned for the queries that actually run. A few examples:</p>

    <ul>
      <li><strong>Single-index timeline queries</strong> &mdash; the entry list filters by user but sorts by publish date, columns that used to live on different tables. Lion Reader denormalizes the sort key so a single index serves the filter and the sort together, with the row limit pushed down into the index scan.</li>
      <li><strong>Pre-sanitized content</strong> &mdash; sanitizing a large article is the dominant cost of loading it, so sanitized HTML is computed once on write and stored, not re-computed on every read.</li>
      <li><strong>Shared, deduplicated feeds</strong> &mdash; a feed is fetched once and served to every subscriber, so popular feeds don&rsquo;t multiply work.</li>
    </ul>

    <p>The result: typical cached page loads land <strong>under 100ms on inexpensive cloud hosts</strong> and under 20ms on desktop hardware. Those are the numbers we see in practice on Lion Reader&rsquo;s own deployment &mdash; your mileage depends on your hardware and feeds, but the whole system is built to stay fast as it grows.</p>
  `,
};

export default article;
