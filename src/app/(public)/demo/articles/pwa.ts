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
  summaryHtml: `<p>Install Lion Reader from your browser onto your phone, tablet, or computer &mdash; no app store needed &mdash; with an icon, window, and automatic updates. On Android it appears in the <strong>share menu</strong>, so you can save links and files too. On iPhone and iPad, add it via Safari&rsquo;s Share menu.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Lion Reader can be installed on your phone, tablet, or computer straight from your browser &mdash; no app store needed. It gets its own icon and opens in its own window, like any other app, and updates itself automatically.</p>

    <h3>Save From the Share Menu</h3>

    <p>Once it&rsquo;s installed on Android, Lion Reader shows up in your phone&rsquo;s share menu. Share a link from your browser or any other app and it&rsquo;s <a href="/demo/all?entry=save-for-later">saved for later</a>. You can share files too &mdash; a Word document, Markdown, or HTML file becomes a <a href="/demo/all?entry=file-upload">saved article</a> you can read right away.</p>

    <p>On iPhone and iPad, the <a href="/demo/all?entry=wallabag-api">Wallabag app</a> gives you the same share-menu saving.</p>

    <details>
      <summary>How to install</summary>
      <p>On Android or a desktop browser like Chrome or Edge, look for <strong>Install</strong> in the browser menu or address bar. On iPhone and iPad, open Lion Reader in Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
    </details>
  `,
};

export default article;
