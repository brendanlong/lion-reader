const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** Normalize a bare 32-hex or dashed Notion id to dashed UUID form; null if it is neither. */
export function formatNotionId(id: string): string | null {
  const lower = id.toLowerCase();
  if (UUID_PATTERN.test(lower)) return lower;
  if (!BARE_ID_PATTERN.test(lower)) return null;
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}
