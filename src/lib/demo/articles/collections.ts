import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "collections",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/1810",
  title: "Organize Articles into Collections",
  author: null,
  summary:
    "Gather articles into named collections that sit in the sidebar like feeds, read books and other collections in order, and file things as you save them.",
  publishedAt: new Date("2026-10-04T12:00:00Z"),
  score: 90,
  starred: false,
  summaryHtml: `<p>Collections are named, user-made lists of articles that appear in the sidebar like feeds, with their own unread counts. An article can be in many collections without being copied, and collections can have a reading order, as imported ebooks do. Uploads and Wallabag tags can file articles into them.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-28"),
  contentHtml: `
    <p>Collections are named lists of articles you put together yourself &mdash; &ldquo;Recipes to Try,&rdquo; &ldquo;Trip Planning,&rdquo; the reading for a course. Open an article, click <strong>Add to Collection</strong>, and check a collection or type a new name to create one. An article can be in as many collections as you like, and it works for posts from the sites you follow as well as your <a href="/demo/all?entry=save-for-later">saved articles</a>. Try it on this article.</p>

    <p>Each collection appears in the sidebar like a feed, with its own unread count, so you can read it on its own. Like a feed, you can rename it or give it <a href="/demo/all?entry=tags">tags</a> with the pencil icon next to it. An article in a collection isn&rsquo;t a copy: it stays in its feed or in Saved, and reading or starring it in one place shows everywhere. Removing it from a collection, or deleting the collection, leaves the article where it was &mdash; unless you choose to also delete the collection&rsquo;s saved articles that aren&rsquo;t in another collection.</p>

    <h3>Keep Them in Order</h3>

    <p>A collection can have a reading order. When it does, it opens in that order, and the sort menu above the list switches between that order and date. When you <a href="/demo/all?entry=books">import an ebook</a>, it becomes a collection with an article per chapter, in the book&rsquo;s order. You can also ask your <a href="/demo/all?entry=mcp-server">AI assistant</a> to build a collection for you, or to put one in a sensible reading order.</p>

    <h3>File Things as You Save Them</h3>

    <p>When you <a href="/demo/all?entry=file-upload">upload a file</a>, you can pick a collection for it, and when you upload while viewing a collection, it&rsquo;s picked for you. In the <a href="/demo/all?entry=wallabag-api">Wallabag app</a>, tags are your collections: tag an article in the app and it&rsquo;s in that collection in Lion Reader. Your AI assistant can save a link straight into a collection too.</p>
  `,
};

export default article;
