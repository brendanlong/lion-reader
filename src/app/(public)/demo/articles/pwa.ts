import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "pwa",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/413",
  title: "Install Lion Reader Like an App",
  author: null,
  summary:
    "Add Lion Reader to your home screen or desktop for an app-like experience, and save links and files from your phone's share menu.",
  publishedAt: new Date("2026-01-08T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Install Lion Reader on your phone, tablet, or computer straight from your browser, with no app store needed &mdash; it gets its own icon, opens without the browser&rsquo;s address bar, and updates automatically. On Android, it appears in your phone&rsquo;s share menu, so shared links or files are saved for later.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader works in any browser on your phone, tablet, or computer, and you can install it straight from the browser &mdash; no app store needed. It gets its own icon, opens without the browser&rsquo;s address bar and tabs, and updates itself automatically. It needs a connection to load articles. If you&rsquo;d rather use a native app you already have, Lion Reader also works with <a href="/demo/all?entry=google-reader-api">many RSS apps</a>.</p>

    <h3>Save From the Share Menu</h3>

    <p>On Android, an installed Lion Reader shows up in your phone&rsquo;s share menu. Share a link from your browser or any other app and it&rsquo;s <a href="/demo/all?entry=save-for-later">saved for later</a>. You can share files too &mdash; a Word document, Markdown, or HTML file becomes a <a href="/demo/all?entry=file-upload">saved article</a> you can read right away. On iPhone and iPad, where installed web apps can&rsquo;t receive shares, the free <a href="/demo/all?entry=wallabag-api">Wallabag app</a> gives you the same share-menu saving.</p>

    <details>
      <summary>How to install</summary>
      <p>On Android or a desktop browser like Chrome or Edge, look for <strong>Install</strong> in the browser menu or address bar. On iPhone and iPad, open Lion Reader in Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
    </details>
  `,
};

export default article;
