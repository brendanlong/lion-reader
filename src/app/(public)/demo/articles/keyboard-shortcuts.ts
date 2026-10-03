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
  summaryHtml: `<p>Lion Reader gives every common action a keyboard shortcut, letting you move through unread articles without the mouse: <strong>j/k</strong> to navigate, m to mark read, s to star, and / to search. Press g then a letter to jump to a section, and ? shows the full list anytime.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Once you learn a few keys, the keyboard is the fastest way through a pile of unread articles. Most everyday actions in Lion Reader have a shortcut, and you can try them right here in the demo. Press <kbd>?</kbd> anytime to see the full list.</p>

    <h3>The Essentials</h3>

    <ul>
      <li><kbd>j</kbd> / <kbd>k</kbd> &mdash; next and previous article, whether you&rsquo;re in the list or reading</li>
      <li><kbd>Enter</kbd> or <kbd>o</kbd> to open, <kbd>Escape</kbd> to close</li>
      <li><kbd>m</kbd> &mdash; mark read or unread</li>
      <li><kbd>s</kbd> &mdash; star</li>
      <li><kbd>v</kbd> &mdash; open the selected article&rsquo;s original page in a new tab</li>
      <li><kbd>/</kbd> &mdash; <a href="/demo/all?entry=search">search</a> from the article list</li>
    </ul>

    <h3>Getting Around</h3>

    <p>From the article list, press <kbd>g</kbd> and then a letter to jump to a section: <kbd>g</kbd> <kbd>a</kbd> for all articles, <kbd>g</kbd> <kbd>s</kbd> for starred, and <kbd>g</kbd> <kbd>l</kbd> for <a href="/demo/all?entry=save-for-later">saved</a>. There are also shortcuts to control <a href="/demo/all?entry=text-to-speech">narration</a>, like <kbd>p</kbd> to play or pause.</p>

    <p>Shortcuts stay out of the way while you&rsquo;re typing in a search box or form, so you never trigger one by accident.</p>
  `,
};

export default article;
