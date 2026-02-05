/**
 * Shared types for hooks
 *
 * Common type definitions used across multiple hooks.
 */

import { type EntryType } from "./useEntryMutations";

/**
 * Entry data for list display and navigation.
 * Includes all fields needed for rendering and keyboard/swipe navigation.
 */
export interface EntryListData {
  id: string;
  feedId: string;
  subscriptionId: string | null;
  type: EntryType;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  /** Site name for saved articles (e.g., "arXiv", "LessWrong", extracted from og:site_name) */
  siteName: string | null;
}
