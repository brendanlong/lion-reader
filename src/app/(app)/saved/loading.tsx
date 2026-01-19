/**
 * Saved Articles Loading State
 *
 * Renders the actual content component during navigation, allowing it to
 * use cached data from React Query while the server prefetch runs.
 *
 * This enables instant navigation with cached/placeholder data, and when
 * the server component completes, the prefetched data merges seamlessly.
 *
 * Trade-off: Initial page load (no cache) shows the component's loading
 * state briefly before server data arrives.
 */

import { SavedArticlesContent } from "./SavedArticlesContent";

export default function SavedEntriesLoading() {
  // Render the actual content component - it will use cached data if available
  return <SavedArticlesContent />;
}
