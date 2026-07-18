/**
 * Type for individual demo article files.
 *
 * Each article specifies its own subscription, starred status, and published date.
 * The main data.ts file generates everything else (entry counts, feedTitle, etc.).
 */
export interface DemoArticle {
  id: string;
  subscriptionId: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string;
  author: string | null;
  summary: string;
  publishedAt: Date;
  starred: boolean;
  contentHtml: string;
  /** Pre-generated AI summary HTML (from Claude Sonnet) for the demo summary card */
  summaryHtml: string;
  /**
   * Optional hero illustration (path under public/demo/, e.g. "/demo/text-to-speech.png").
   * Rendered at the top of the article. Generate it at ~1200x630. See
   * src/app/demo/articles/CLAUDE.md for the house style.
   *
   * The social/OG preview uses the opaque `-og.png` sibling instead (see `ogImage`):
   * transparent heroes flatten unpredictably on social cards, so heroes may be
   * transparent while their OG variant bakes in a background.
   */
  heroImage?: string;
  /**
   * Overrides the social/OG preview image. When omitted it defaults to the
   * `-og.png` sibling of `heroImage` (e.g. "/demo/foo.png" → "/demo/foo-og.png"),
   * which must be an opaque 1200x630 variant. Set this only to break that
   * convention. See `resolveOgImage` in data.ts.
   */
  ogImage?: string;
  /** Alt text for heroImage; falls back to "<title> illustration" when omitted. */
  heroImageAlt?: string;
}
