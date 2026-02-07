import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "welcome",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Welcome to Lion Reader",
  author: null,
  summary: "A modern, fast, and open-source feed reader. Explore the demo to see what it can do.",
  publishedAt: new Date(),
  starred: true,
  summaryHtml: `<p><strong>Lion Reader</strong> is a self-hostable RSS reader that combines feeds, email newsletters, and saved articles in one interface. It features <strong>AI-powered summaries</strong> via Claude, text-to-speech narration, keyboard-first navigation, real-time updates, and <strong>MCP integration</strong> for connecting AI assistants. Privacy-focused with on-device ML scoring.</p>`,
  contentHtml: `
    <h2>Welcome to Lion Reader</h2>

    <p>Lion Reader is a modern, self-hostable feed reader built for people who care about their reading experience. Whether you&rsquo;re following hundreds of feeds or just a handful, Lion Reader brings all your content together in one fast, elegant interface.</p>

    <p>This interactive demo shows the real Lion Reader UI &mdash; browse the sidebar to explore different features and see what makes this reader special. Everything you see here works exactly like the production app.</p>

    <h3>Key Features</h3>

    <ul>
      <li><strong>All your content in one place</strong> &mdash; Subscribe to RSS, Atom, and JSON feeds, receive email newsletters directly into your reader, and save articles from around the web for later reading.</li>
      <li><strong>AI-powered reading</strong> &mdash; Get instant article summaries powered by Claude, listen to entries with high-quality text-to-speech narration, and let on-device ML predict which articles you&rsquo;ll love.</li>
      <li><strong>MCP integration</strong> &mdash; Connect AI assistants like Claude Desktop directly to your feeds via the Model Context Protocol. Let your AI help you search, organize, and manage your reading list.</li>
      <li><strong>Keyboard-first design</strong> &mdash; Navigate your entire reading experience without touching your mouse. Every action has a keyboard shortcut.</li>
      <li><strong>Real-time updates</strong> &mdash; New entries appear instantly via Server-Sent Events. No refreshing, no polling, just seamless updates as content arrives.</li>
      <li><strong>Progressive Web App</strong> &mdash; Install Lion Reader on desktop or mobile for a native app experience. Share articles directly from your phone.</li>
      <li><strong>Privacy-focused</strong> &mdash; Self-hostable and open source. No tracking, no ads, no data mining. Your reading habits are yours alone.</li>
      <li><strong>On-device ML</strong> &mdash; Score predictions run locally in your browser via ONNX Runtime. Your reading patterns never leave your device.</li>
    </ul>

    <h3>Explore the Demo</h3>

    <p>The sidebar is organized into sections that showcase different capabilities:</p>

    <ul>
      <li><strong>Feed Types</strong> &mdash; See how Lion Reader handles RSS feeds, email newsletters, and saved articles</li>
      <li><strong>Reading Experience</strong> &mdash; Explore full content fetching, AI summaries, text-to-speech, and keyboard navigation</li>
      <li><strong>Organization &amp; Search</strong> &mdash; Learn about tags, full-text search, ML-powered scoring, and OPML import/export</li>
      <li><strong>Integrations &amp; Sync</strong> &mdash; Discover MCP integration, WebSub push, the PWA, and real-time updates</li>
    </ul>

    <p>Ready to take control of your reading? Sign up to start using the full app, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">check out the source code on GitHub</a> to self-host your own instance.</p>
  `,
};

export default article;
