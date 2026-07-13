/**
 * Formats an Anthropic model ID into a human-readable name for display.
 *
 * Model IDs look like "claude-sonnet-4-6", "claude-opus-4-8", or the older
 * "claude-3-5-sonnet-20240620" shape. This:
 *
 * - Strips the "claude-" prefix and renders it as a leading "Claude"
 * - Drops a trailing 8-digit date suffix (e.g. "-20240620")
 * - Title-cases word segments ("sonnet" -> "Sonnet")
 * - Joins consecutive numeric segments with dots ("4-6" -> "4.6")
 *
 * Examples:
 *   "claude-sonnet-4-6"          -> "Claude Sonnet 4.6"
 *   "claude-opus-4-8"            -> "Claude Opus 4.8"
 *   "claude-3-5-sonnet-20240620" -> "Claude 3.5 Sonnet"
 *
 * Unknown / non-Claude IDs fall back to title-casing their segments so the
 * output is never worse than the raw ID.
 */
export function formatModelName(modelId: string): string {
  if (!modelId) {
    return modelId;
  }

  // Drop a trailing 8-digit date suffix (e.g. "claude-sonnet-4-5-20250929").
  const withoutDate = modelId.replace(/-\d{8}$/, "");

  const hasClaudePrefix = withoutDate.startsWith("claude-");
  const rest = hasClaudePrefix ? withoutDate.slice("claude-".length) : withoutDate;

  const segments = rest.split("-").filter((segment) => segment.length > 0);

  // Group consecutive numeric segments so they can be joined with dots, while
  // word segments stay space-separated.
  const groups: string[] = [];
  let numericRun: string[] = [];

  const flushNumericRun = () => {
    if (numericRun.length > 0) {
      groups.push(numericRun.join("."));
      numericRun = [];
    }
  };

  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      numericRun.push(segment);
    } else {
      flushNumericRun();
      groups.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  flushNumericRun();

  const formatted = groups.join(" ");

  if (hasClaudePrefix) {
    return formatted ? `Claude ${formatted}` : "Claude";
  }

  return formatted;
}
