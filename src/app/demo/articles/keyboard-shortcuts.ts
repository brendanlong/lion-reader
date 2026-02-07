import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "keyboard-shortcuts",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/68",
  title: "Keyboard Shortcuts",
  author: null,
  summary: "Navigate your entire reading workflow without touching the mouse.",
  publishedAt: new Date("2025-12-27T14:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader offers comprehensive keyboard navigation inspired by Vim, enabling fast, mouse-free reading workflows.</p>
<p><strong>List Navigation:</strong> Use <code>j</code>/<code>k</code> to move down/up through entries, <code>Enter</code> to open, <code>n</code>/<code>p</code> to jump between articles, and <code>Escape</code> to close.</p>
<p><strong>Entry Actions:</strong> Press <code>m</code> to mark read/unread, <code>s</code> to star/unstar, and <code>v</code> to open the original URL in a new tab.</p>
<p><strong>Section Navigation:</strong> Two-key combinations starting with <code>g</code> jump between major sections: <code>g+a</code> for All Items, <code>g+s</code> for Starred, <code>g+l</code> for Saved articles.</p>
<p><strong>Smart Design:</strong> Shortcuts automatically disable when typing in search fields or text inputs, preventing accidental navigation. Touch devices feature 44px minimum touch targets following WCAG accessibility guidelines, ensuring the interface works seamlessly with both keyboard and touch input methods.</p>`,
  contentHtml: `
    <h2>Keyboard Shortcuts</h2>

    <p>Mouse or touch interfaces work fine, but keyboard navigation is faster once you learn it. Lion Reader follows a keyboard-first design philosophy inspired by Vim, giving every core action a keyboard shortcut so you can blaze through your reading workflow without touching the mouse.</p>

    <h3>List Navigation</h3>

    <p>Navigate your entry list with <kbd>j</kbd> and <kbd>k</kbd> to move down and up respectively. Press <kbd>Enter</kbd> to open the selected entry. Once you&rsquo;re reading, <kbd>n</kbd> and <kbd>p</kbd> jump to the next and previous articles. Hit <kbd>Escape</kbd> to close the article and return to the list.</p>

    <h3>Entry Actions</h3>

    <p>Manage entries without leaving the keyboard. Press <kbd>m</kbd> to mark an entry as read or unread. Hit <kbd>s</kbd> to toggle starred status. Press <kbd>v</kbd> to open the original article URL in a new browser tab. These shortcuts work whether you&rsquo;re viewing the list or reading an article.</p>

    <h3>Navigation Shortcuts</h3>

    <p>Jump between major sections with two-key combinations. Press <kbd>g</kbd> followed by <kbd>a</kbd> to go to All Items. Press <kbd>g</kbd> then <kbd>s</kbd> for Starred items. Press <kbd>g</kbd> then <kbd>l</kbd> to open your Saved articles. The <kbd>g</kbd> prefix activates for 1.5 seconds, giving you time to press the second key.</p>

    <h3>Smart Focus Detection</h3>

    <p>Shortcuts respect focus state and won&rsquo;t fire when you&rsquo;re typing in a search field or text input. This prevents accidental navigation while you&rsquo;re entering text. But when focus is on the reading interface, every core action is just a keypress away.</p>

    <p>On touch devices, Lion Reader follows WCAG accessibility guidelines with 44px minimum touch targets for comfortable tapping. The interface works great with both keyboard and touch &mdash; use whichever input method fits your current context.</p>
  `,
};

export default article;
