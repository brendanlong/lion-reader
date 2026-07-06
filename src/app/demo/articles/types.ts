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
   * Rendered at the top of the article AND used as the social/OG preview image, so
   * generate it at ~1200x630. See src/app/demo/articles/CLAUDE.md for the house style.
   */
  heroImage?: string;
  /** Alt text for heroImage; falls back to "<title> illustration" when omitted. */
  heroImageAlt?: string;
}
