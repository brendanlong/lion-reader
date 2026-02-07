import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "save-for-later",
  subscriptionId: "feed-types",
  type: "saved",
  url: null,
  title: "Save for Later",
  author: null,
  summary: "Save any web page, upload documents, or capture articles for later reading.",
  publishedAt: new Date("2025-12-27T16:00:00Z"),
  starred: false,
  contentHtml: `
    <h2>Save for Later: Your Personal Reading Archive</h2>

    <p>Lion Reader&rsquo;s Save for Later feature transforms any web page, document, or article into a clean, distraction-free reading experience. Using Mozilla&rsquo;s battle-tested <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Readability algorithm</a> &mdash; the same technology behind Firefox Reader View &mdash; Lion Reader extracts the main content from cluttered web pages, removes ads and navigation chrome, and presents you with a beautifully formatted article ready for focused reading.</p>

    <h3>Multiple Ways to Save</h3>

    <p>Lion Reader offers flexibility in how you capture content for later reading:</p>

    <ul>
      <li><strong>Browser bookmarklet</strong> &mdash; One-click saving from any page while browsing</li>
      <li><strong>PWA share target</strong> &mdash; Use your phone&rsquo;s native share menu to send articles directly to Lion Reader</li>
      <li><strong>MCP integration</strong> &mdash; Save articles via AI assistants like Claude</li>
      <li><strong>tRPC API</strong> &mdash; Programmatic saving for automation and integrations</li>
      <li><strong>Discord bot</strong> &mdash; Save articles via Discord commands</li>
      <li><strong>File upload</strong> &mdash; Upload PDFs, Markdown files, Word documents, and other file types directly</li>
      <li><strong>Google Docs import</strong> &mdash; Import Google Docs directly with the optional OAuth scope</li>
    </ul>

    <h3>Custom Metadata &amp; Organization</h3>

    <p>When saving articles, you can set custom metadata including title, description, and author &mdash; perfect for adding context or fixing incorrect extraction. Saved articles appear in a dedicated &ldquo;Saved&rdquo; section in your sidebar, but they&rsquo;re fully integrated with the rest of Lion Reader: star important articles, tag them for organization, search across saved content, and browse your reading archive chronologically. Unlike traditional bookmarks that rot over time as pages disappear, your saved articles are preserved with full content extraction, ensuring your reading list remains accessible indefinitely.</p>
  `,
};

export default article;
