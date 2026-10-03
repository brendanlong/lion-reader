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
  summaryHtml: `<p>Lion Reader is a Progressive Web App (PWA) that can be installed on any device without app stores. Once installed, it acts as a <strong>share target</strong> on mobile, allowing you to save URLs, Markdown, and Word files directly from any app&#39;s native share menu, making it a universal read-it-later inbox.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
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
