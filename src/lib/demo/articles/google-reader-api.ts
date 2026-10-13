import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "google-reader-api",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/605",
  title: "Use Your Favorite RSS App",
  author: null,
  summary:
    "Already love a feed reader app on your phone or desktop? Connect it to Lion Reader and everything stays in sync.",
  publishedAt: new Date("2026-02-20T01:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader syncs with apps that support the Google Reader standard &mdash; like NetNewsWire, Read You, and NewsFlash &mdash; keeping subscriptions, newsletters, tags, unread counts, and read or starred status in sync everywhere, including saved articles as their own subscription. Set it up by choosing <strong>FreshRSS</strong> as the service type.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader works on your phone, tablet, and computer &mdash; in the browser or <a href="/demo/all?entry=pwa">installed like an app</a>. But if you already have a favorite feed reader app, keep using it. Lion Reader works with apps that support the widely used Google Reader sync standard &mdash; like NetNewsWire and Reeder Classic on iPhone and Mac, Read You and FocusReader on Android, and NewsFlash on Linux &mdash; so you can read wherever you like and everything stays in sync.</p>

    <h3>What Syncs</h3>

    <p>Your subscriptions, <a href="/demo/all?entry=email-newsletters">newsletters</a>, tags (as folders), and unread counts all show up in the app. Read or star an article on your phone and it&rsquo;s read or starred everywhere. Your <a href="/demo/all?entry=save-for-later">saved articles</a> come along too, as their own subscription. You can even subscribe, unsubscribe, and organize folders from inside the app. Features like <a href="/demo/all?entry=text-to-speech">listening</a> and <a href="/demo/all?entry=ai-summaries">summaries</a> stay in Lion Reader itself.</p>

    <details>
      <summary>How to set it up</summary>
      <p>In your app&rsquo;s account settings, choose <strong>FreshRSS</strong> as the service type &mdash; Lion Reader speaks the same sync language. Then sign in with the server address <code>https://lionreader.com/api/greader.php</code> (or your own server&rsquo;s address, shown under <strong>Settings &rarr; Integrations</strong>) and your Lion Reader email and password. If you sign in with Google or Apple, set a password in Account settings first.</p>
    </details>
  `,
};

export default article;
