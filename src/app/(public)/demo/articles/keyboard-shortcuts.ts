import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "keyboard-shortcuts",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/68",
  title: "Keyboard Shortcuts",
  author: null,
  summary:
    "Fly through your reading without touching the mouse: move between articles, star, mark read, search, and control narration from the keyboard.",
  publishedAt: new Date("2025-12-27T14:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader supports Gmail- and Google Reader-style keyboard shortcuts for moving through articles, marking them read, starring, and searching, plus a <strong>g</strong> then letter combination to jump to sections like all articles, starred, or saved for later. Press <strong>?</strong> to see the full list; shortcuts stay disabled while you&rsquo;re typing.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>If you&rsquo;ve used Google Reader or Gmail, the core keys &mdash; <kbd>j</kbd>, <kbd>k</kbd>, <kbd>s</kbd>, and friends &mdash; will feel familiar. They&rsquo;re the fastest way through a pile of unread articles, and you can try them right here in the demo. Press <kbd>?</kbd> anytime to see the full list.</p>

    <h3>The Essentials</h3>

    <ul>
      <li><kbd>j</kbd> / <kbd>k</kbd> &mdash; next and previous article, whether you&rsquo;re in the list or reading</li>
      <li><kbd>Enter</kbd> or <kbd>o</kbd> to open, <kbd>Escape</kbd> to close</li>
      <li><kbd>m</kbd> &mdash; mark read or unread</li>
      <li><kbd>s</kbd> &mdash; star</li>
      <li><kbd>v</kbd> &mdash; open the selected article&rsquo;s original page in a new tab</li>
      <li><kbd>u</kbd> &mdash; show or hide articles you&rsquo;ve read</li>
      <li><kbd>/</kbd> &mdash; <a href="/demo/all?entry=search">search</a> from the article list</li>
    </ul>

    <h3>Getting Around</h3>

    <p>From the article list, press <kbd>g</kbd> and then a letter to jump to a section:</p>

    <ul>
      <li><kbd>g</kbd> <kbd>a</kbd> &mdash; all articles</li>
      <li><kbd>g</kbd> <kbd>s</kbd> &mdash; starred</li>
      <li><kbd>g</kbd> <kbd>l</kbd> &mdash; <a href="/demo/all?entry=save-for-later">saved for later</a></li>
    </ul>

    <p>While <a href="/demo/all?entry=text-to-speech">listening</a>, press <kbd>p</kbd> to play or pause. Shortcuts stay out of the way while you&rsquo;re typing, so you never trigger one by accident.</p>
  `,
};

export default article;
