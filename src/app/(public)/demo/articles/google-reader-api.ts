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
  summaryHtml: `<p>Lion Reader works with apps that support the <strong>Google Reader sync standard</strong>, like NetNewsWire, Reeder Classic, and NewsFlash. Subscriptions, tags, unread counts, and read/star state sync automatically, and saved articles appear as their own subscription. Set up by choosing FreshRSS as the service type and signing in with your credentials.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Already have a favorite feed reader app on your phone, tablet, or desktop? Keep using it. Lion Reader works with apps that support the widely used Google Reader sync standard &mdash; like NetNewsWire, Reeder Classic, Read You, FocusReader, and NewsFlash &mdash; so you can read wherever you like and everything stays in sync.</p>

    <h3>What Syncs</h3>

    <p>Your subscriptions, tags (as folders), and unread counts all show up in the app. Read or star an article on your phone and it&rsquo;s read or starred everywhere. Your <a href="/demo/all?entry=save-for-later">saved articles</a> come along too, as their own subscription. You can even subscribe, unsubscribe, and organize folders from inside the app.</p>

    <h3>Setting It Up</h3>

    <p>In your app&rsquo;s account settings, choose <strong>FreshRSS</strong> as the service type, then sign in with the server address shown in Lion Reader&rsquo;s settings and your Lion Reader email and password. (If you sign in with Google or Apple, set a password in Account settings first.)</p>
  `,
};

export default article;
