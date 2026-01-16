/**
 * Shared component for displaying reading time estimate.
 * Used in entry list items and full entry views with context-appropriate styling.
 */

interface ReadingTimeDisplayProps {
  /**
   * The reading time string (e.g., "5 min read" or "< 1 min read").
   * If null or undefined, nothing is rendered.
   */
  readingTime: string | null | undefined;
  /**
   * The separator to display before the reading time.
   * "dot" uses · separator (for list items)
   * "pipe" uses | separator (for full entry view)
   */
  separator?: "dot" | "pipe";
  /**
   * Whether this is in a responsive context where separator hides on mobile.
   * Default: false
   */
  responsiveSeparator?: boolean;
}

/**
 * Displays reading time estimate with appropriate separator and styling.
 * Returns null if readingTime is not provided.
 */
export function ReadingTimeDisplay({
  readingTime,
  separator = "dot",
  responsiveSeparator = false,
}: ReadingTimeDisplayProps) {
  if (!readingTime) return null;

  const separatorChar = separator === "pipe" ? "|" : "·";

  // For "pipe" separator with responsive behavior
  if (responsiveSeparator) {
    return (
      <>
        <span aria-hidden="true" className="hidden text-zinc-400 sm:inline dark:text-zinc-600">
          {separatorChar}
        </span>
        <span className="basis-full sm:basis-auto">{readingTime}</span>
      </>
    );
  }

  // For inline dot separator (default)
  return (
    <>
      <span aria-hidden="true">{separatorChar}</span>
      <span className="shrink-0">{readingTime}</span>
    </>
  );
}
