import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "appearance",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/304",
  title: "Appearance & Themes",
  author: null,
  summary:
    "Pick your font, text size, and list layout, and choose a theme for daytime, late-night reading, or e-ink screens.",
  publishedAt: new Date("2025-12-28T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader lets you customize reading comfort: choose <strong>Light</strong>, <strong>Dark</strong>, or <strong>E-paper</strong> themes (or Auto, which follows your device), pick fonts and text size, choose paragraph alignment, and switch between Comfortable and Compact list views to fit more articles on screen.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Reading comfort is personal, so Lion Reader lets you set things up the way your eyes like them. Changes apply instantly as you adjust them.</p>

    <h3>Themes for Any Light</h3>

    <ul>
      <li><strong>Light</strong> &mdash; clean and bright for daytime reading.</li>
      <li><strong>Dark</strong> &mdash; made for reading in bed. It uses warm amber highlights and neutral grays, with no blue, to cut down on blue light late at night.</li>
      <li><strong>E-paper</strong> &mdash; for Kindle, Kobo, Boox, and other e-ink screens, with high contrast that stays readable in grayscale.</li>
    </ul>

    <p>Leave it on <strong>Auto</strong> and Lion Reader follows your device&rsquo;s light or dark setting &mdash; and switches to e-paper on its own when it recognizes an e-reader.</p>

    <h3>Text the Way You Like It</h3>

    <p>Choose from a selection of serif and sans-serif fonts, or use your device&rsquo;s own. Make the text bigger or smaller, and pick left-aligned or justified paragraphs.</p>

    <h3>Roomy or Compact Lists</h3>

    <p>The default <strong>Comfortable</strong> list shows each article as a card with a preview. Switch to <strong>Compact</strong> to fit many more articles on screen at once when you&rsquo;re working through a backlog.</p>
  `,
};

export default article;
