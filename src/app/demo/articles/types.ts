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
}
