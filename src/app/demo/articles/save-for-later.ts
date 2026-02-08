import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "save-for-later",
  subscriptionId: "feed-types",
  type: "saved",
  url: "https://github.com/brendanlong/lion-reader/pull/57",
  title: "Save for Later",
  author: null,
  summary: "Save any web page, upload documents, or capture articles for later reading.",
  publishedAt: new Date("2025-12-27T16:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader&#39;s Save for Later uses Mozilla&#39;s Readability algorithm to extract clean content from web pages. Save via bookmarklet, PWA share, MCP, API, Discord, or upload Markdown/Word/HTML files directly. Saved articles integrate fully with starring, tagging, and search, preserving content even if original pages disappear.</p>`,
  contentHtml: `
    <p>Lion Reader&rsquo;s Save for Later feature transforms any web page, document, or article into a clean, distraction-free reading experience. Using Mozilla&rsquo;s battle-tested <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Readability algorithm</a> &mdash; the same technology behind Firefox Reader View &mdash; Lion Reader extracts the main content from cluttered web pages, removes ads and navigation chrome, and presents you with a beautifully formatted article ready for focused reading.</p>

    <h3>Multiple Ways to Save</h3>

    <p>Lion Reader offers flexibility in how you capture content for later reading:</p>

    <ul>
      <li><strong>Browser bookmarklet</strong> &mdash; One-click saving from any page while browsing</li>
      <li><strong>PWA share target</strong> &mdash; Use your phone&rsquo;s native share menu to send articles directly to Lion Reader</li>
      <li><strong>MCP integration</strong> &mdash; Save articles via AI assistants like Claude</li>
      <li><strong>tRPC API</strong> &mdash; Programmatic saving for automation and integrations</li>
      <li><strong>Discord bot</strong> &mdash; Save articles shared in Discord channels</li>
      <li><strong>File upload</strong> &mdash; Upload Markdown files, Word documents, and HTML files directly</li>
      <li><strong>Google Docs import</strong> &mdash; Import Google Docs directly with the optional OAuth scope</li>
    </ul>

    <h3>Custom Metadata &amp; Organization</h3>

    <p>When saving articles, you can provide a custom title to override automatic extraction. Saved articles appear in a dedicated &ldquo;Saved&rdquo; section in your sidebar, but they&rsquo;re fully integrated with the rest of Lion Reader: star important articles, tag them for organization, search across saved content, and browse your reading archive chronologically. Unlike traditional bookmarks that rot over time as pages disappear, your saved articles are preserved with full content extraction, ensuring your reading list remains accessible indefinitely.</p>
  `,
};

export default article;
