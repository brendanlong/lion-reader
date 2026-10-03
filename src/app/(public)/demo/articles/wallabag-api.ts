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
  summaryHtml: `<p>Lion Reader works with the free Wallabag app for Android and iOS: share a link to it and the article is saved to Lion Reader, without needing a Wallabag account. This is the easiest way to save on iPhone and iPad, where you can also read saved articles offline.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader works with the free <a href="https://wallabag.org/" target="_blank" rel="noopener noreferrer">Wallabag</a> read-it-later apps for <a href="https://play.google.com/store/apps/details?id=fr.gaulupeau.apps.InThePoche" target="_blank" rel="noopener noreferrer">Android</a> and <a href="https://apps.apple.com/app/wallabag-2-official/id1170800946" target="_blank" rel="noopener noreferrer">iOS</a>. Once connected, tap <strong>Share</strong> in your browser, your social media app, or anywhere else, pick Wallabag, and the link is saved to Lion Reader. You don&rsquo;t need a Wallabag account; the app signs in with your Lion Reader account.</p>

    <p>On iPhone and iPad, this is the easiest way to save from the share menu, since an <a href="/demo/all?entry=pwa">installed Lion Reader</a> can only receive shares on Android. You can also browse, star, archive, and delete your <a href="/demo/all?entry=save-for-later">saved articles</a> from inside the app, with changes synced back to Lion Reader, and read them offline. The app shows only saved articles; to read the sites and newsletters you follow on your phone, use <a href="/demo/all?entry=google-reader-api">your favorite RSS app</a>.</p>

    <h3>Setting It Up</h3>

    <p>On Android, scan the QR code in Lion Reader&rsquo;s settings (or tap the link next to it) and the app fills in most of the setup for you &mdash; you just enter your password and check your username. On iOS, copy the server URL, client ID, and client secret from the same page into the app, along with your email and password. (If you sign in with Google or Apple, set a password in Account settings first.)</p>
  `,
};

export default article;
