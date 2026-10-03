import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "wallabag-api",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/652",
  title: "Save from Your Phone with Wallabag",
  author: null,
  summary:
    "Use the free Wallabag app on Android or iOS to save links to Lion Reader from any app's share menu.",
  publishedAt: new Date("2026-02-22T20:33:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader implements a <strong>Wallabag-compatible API</strong> that lets you use the official Wallabag mobile apps on Android and iOS to save articles directly to your Lion Reader account. Share any URL from your phone to the Wallabag app, and it appears in Lion Reader as a saved article. The API also supports viewing, archiving, starring, and deleting saved articles from the app.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-22"),
  contentHtml: `
    <p>Lion Reader works with the free <a href="https://wallabag.org/" target="_blank" rel="noopener noreferrer">Wallabag</a> read-it-later apps for <a href="https://play.google.com/store/apps/details?id=fr.gaulupeau.apps.InThePoche" target="_blank" rel="noopener noreferrer">Android</a> and <a href="https://apps.apple.com/app/wallabag-2-official/id1170800946" target="_blank" rel="noopener noreferrer">iOS</a>. Once connected, tap <strong>Share</strong> in your browser, your social media app, or anywhere else, pick Wallabag, and the link is saved to Lion Reader.</p>

    <p>On iPhone and iPad, this is the easiest way to save from the share menu. You can also browse, star, archive, and delete your <a href="/demo/all?entry=save-for-later">saved articles</a> from inside the app, and read them offline.</p>

    <h3>Setting It Up</h3>

    <p>On Android, scan the QR code in Lion Reader&rsquo;s settings (or tap the link next to it) and the app fills in most of the setup for you &mdash; you just enter your password. On iOS, copy the server details from the same page into the app.</p>
  `,
};

export default article;
