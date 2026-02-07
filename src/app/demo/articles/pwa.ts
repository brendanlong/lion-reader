import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "pwa",
  subscriptionId: "integrations",
  type: "web",
  url: null,
  title: "Progressive Web App",
  author: null,
  summary: "Install Lion Reader on your phone or desktop for a native app-like experience.",
  publishedAt: new Date("2026-01-08T12:00:00Z"),
  starred: false,
  contentHtml: `
    <h2>Install Anywhere</h2>

    <p>Lion Reader is a full Progressive Web App (PWA). This means you can install it on any device &mdash; desktop (Chrome, Edge, Firefox) or mobile (iOS Safari, Android Chrome) &mdash; and get a native app-like experience without downloading anything from an app store. Once installed, Lion Reader runs in its own window with no browser chrome, just like any other app on your device.</p>

    <h3>Share Target Integration</h3>

    <p>One of the most powerful PWA features is share target integration. When you install Lion Reader on your phone, it registers as a share target with your operating system. This means you can save articles directly to Lion Reader using your phone&rsquo;s native share menu from any app &mdash; your browser, Twitter, Reddit, or anywhere else.</p>

    <p>But it goes beyond just URLs. Lion Reader&rsquo;s share target also accepts files, so you can share PDFs, Markdown documents, or even Word files directly into your saved articles. The app automatically detects the content type and processes each file appropriately. This makes Lion Reader a universal inbox for anything you want to read later, not just web content.</p>

    <h3>Mobile Optimizations</h3>

    <p>On mobile devices, the app locks to portrait orientation for optimal reading. This prevents the screen from rotating while you&rsquo;re reading long articles, reducing distractions and maintaining a consistent layout. Combined with push notifications for new entries, the mobile experience rivals dedicated feed reader apps.</p>

    <h3>Single Codebase</h3>

    <p>Unlike traditional native apps, Lion Reader uses a single codebase for web, desktop, and mobile. This means new features and bug fixes ship everywhere simultaneously. No app store reviews, no separate update cycles &mdash; just install directly from the website and get updates automatically. The PWA approach gives you the best of both worlds: the convenience of native apps with the flexibility and speed of the web.</p>
  `,
};

export default article;
