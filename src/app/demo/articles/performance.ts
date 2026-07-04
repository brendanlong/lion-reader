import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "performance",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "Obsessive Performance",
  author: null,
  summary:
    "New articles appear in your lists without a refresh, navigation is instant, and the backend is tuned for sub-100ms page loads.",
  publishedAt: new Date("2026-03-01T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader treats speed as a feature you can feel: <strong>new articles appear in your lists automatically</strong> without a refresh, moving around the app is instant and never reloads what you&rsquo;re reading, your own actions apply the moment you make them, and a carefully tuned backend keeps typical page loads under 100ms.</p>`,
  contentHtml: `
    <p>Most of Lion Reader&rsquo;s features exist in other readers somewhere. What&rsquo;s harder to find is a reader that treats <em>speed</em> as a feature you can feel &mdash; not a nice-to-have, but something worth obsessing over. Lion Reader is built so the interface stays out of your way: updates appear without flicker, navigation is instant, and pages load fast even on the cheapest cloud hardware.</p>

    <h3>Real-time updates without the jank</h3>

    <p>When a new article arrives, it appears in your list automatically &mdash; no refresh, no clicking to load more. It slides into the right spot by date, and if you&rsquo;re partway down a list, your scroll position and the article you&rsquo;re reading stay exactly where they are. Read and starred changes you make on another device show up the same way, without anything jumping around underneath you.</p>

    <h3>Instant navigation</h3>

    <p>Moving around Lion Reader feels instant. Anything you&rsquo;ve already opened &mdash; a subscription, a tag, your saved articles &mdash; comes straight from memory with nothing to reload. Opening something new loads just that content and slots it into place; the rest of the app, including where you were in your current list, stays exactly as it was. There are no full-page reloads as you navigate.</p>

    <h3>Optimistic by default</h3>

    <p>Actions like marking an entry read or starring it take effect the moment you press the key, before the server has even confirmed. If something fails or two devices disagree, Lion Reader keeps whichever change you made most recently &mdash; so the interface feels instant without getting out of sync.</p>

    <h3>A backend built for speed</h3>

    <p>The speed you feel in the interface is backed by a database and server tuned for the work they actually do:</p>

    <ul>
      <li><strong>Lists load in one indexed query</strong> &mdash; paging through your timeline stays fast no matter how many entries you&rsquo;ve accumulated.</li>
      <li><strong>Articles are prepared once, not every time</strong> &mdash; each article&rsquo;s content is cleaned and formatted when it&rsquo;s first fetched, so opening it later is quick even for very long posts.</li>
      <li><strong>Shared feeds</strong> &mdash; a feed is fetched once and served to everyone subscribed to it, instead of repeating the work for each person.</li>
    </ul>

    <p>The result: typical page loads land <strong>under 100ms on inexpensive cloud hosts</strong> and under 20ms on desktop hardware. Those are the numbers we see in practice on Lion Reader&rsquo;s own deployment &mdash; your mileage depends on your hardware and feeds, but the whole system is built to stay fast as it grows.</p>
  `,
};

export default article;
