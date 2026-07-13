import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "plugins",
  subscriptionId: "integrations",
  type: "web",
  url: null,
  title: "Smart Content Sources",
  author: null,
  summary:
    "Lion Reader goes beyond plain RSS to pull in complete, readable content from sources that don't normally cooperate — arXiv papers, GitHub, Google Docs, LessWrong, YouTube, and Bluesky — so you can subscribe and save from them like anything else.",
  publishedAt: new Date("2026-01-20T12:00:00Z"),
  starred: false,
  heroImage: "/demo/plugins.png",
  heroImageAlt:
    "The Lion Reader lion with colorful modular puzzle pieces for different content sources snapping into place.",
  summaryHtml: `<p>Some of the best content on the web doesn&rsquo;t fit neatly into a plain feed &mdash; and even when it does, the feed often leaves out the parts you wanted. Lion Reader has built-in support for popular sources like <strong>arXiv</strong>, <strong>GitHub</strong>, <strong>Google Docs</strong>, <strong>LessWrong</strong>, <strong>YouTube</strong>, and <strong>Bluesky</strong>, so their content comes through complete and easy to read whether you subscribe or save it for later.</p>`,
  contentHtml: `
    <h2>Content from anywhere, made readable</h2>

    <p>Plenty of the web doesn&rsquo;t fit neatly into a plain RSS feed &mdash; and even when it does, the feed often strips out the parts you actually wanted. Lion Reader recognizes a handful of popular sources and pulls in their content complete and easy to read, whether you&rsquo;re subscribing to a feed or <a href="/demo/all?entry=save-for-later">saving something for later</a>. You don&rsquo;t have to do anything special: paste a link and Lion Reader takes care of the rest.</p>

    <h3>LessWrong</h3>

    <p>Subscribe to any author&rsquo;s posts &mdash; and their comments &mdash; even when there&rsquo;s no obvious feed to point at, and save individual posts or comments to read later. Long-form writing comes through with its full text and formatting intact, including properly rendered math, instead of the truncated previews you&rsquo;d get elsewhere.</p>

    <h3>YouTube</h3>

    <p>Subscribe to a channel and new videos arrive in your feed with a playable video player and the full description, so you can watch and read without leaving Lion Reader. Save a video link and you get the same &mdash; the player plus the description &mdash; rather than a stripped-down page. Lion Reader also checks YouTube at a gentle pace so your subscriptions keep working reliably.</p>

    <h3>arXiv</h3>

    <p>Save a paper from an abstract, PDF, or HTML link and Lion Reader brings in the clean, readable version &mdash; preferring the full HTML when it&rsquo;s available &mdash; so you can read comfortably in your reader instead of wrestling with a PDF.</p>

    <h3>GitHub</h3>

    <p>Save a repository, a specific file, or a gist and Lion Reader turns it into a clean article, rendering READMEs and other Markdown the way GitHub does. Documentation reads like a proper page instead of raw source.</p>

    <h3>Google Docs</h3>

    <p>Save a Google Doc straight to Lion Reader with its formatting preserved. Once you grant the optional Google permission, it reads the document directly, so you get the real content instead of a login wall.</p>

    <h3>Bluesky</h3>

    <p>Subscribe to any Bluesky profile and read their posts right in your feed. Normally Bluesky hides the best part of a post &mdash; quoted posts, images, and link cards show up as a bare &ldquo;contains embedded content&rdquo; note &mdash; but Lion Reader fills those back in so you see the whole thing. New Bluesky subscriptions turn this on automatically, and you can switch it off per subscription if you&rsquo;d rather keep posts short.</p>

    <h3>More over time</h3>

    <p>Support for new sources gets added regularly, and once a source is supported it works everywhere Lion Reader does &mdash; the web app, your <a href="/demo/all?entry=mcp-server">AI assistant</a>, and the <a href="/demo/all?entry=discord-bot">Discord bot</a> &mdash; with no setup on your end.</p>
  `,
};

export default article;
