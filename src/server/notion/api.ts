import { z } from "zod";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { HttpFetchError, readResponseWithSizeLimit } from "@/server/http/fetch";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { USER_AGENT } from "@/server/http/user-agent";

/**
 * The Notion web app's own page-loading endpoint. It serves any published
 * ("Publish to web") page without credentials, which the official
 * api.notion.com API does not: that one only reads pages explicitly shared
 * with an integration. Unofficial and unversioned — callers must treat every
 * failure as "no content" (see `src/server/plugins/notion.ts`).
 */
const LOAD_PAGE_CHUNK_URL = "https://www.notion.so/api/v3/loadPageChunk";

const CHUNK_LIMIT = 100;
/** Bound on chunk requests per page; a page needing more is stored truncated. */
const MAX_CHUNKS = 20;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * A block record as the endpoint returns it. `properties` holds rich text and
 * per-type fields (`title`, `source`, `caption`, `language`, …), `format`
 * holds presentation (`page_icon`, `table_block_column_order`, …), and
 * `content` lists child block ids. Loose on purpose: the renderer reads what
 * it recognizes and ignores the rest.
 */
const blockSchema = z.looseObject({
  id: z.string(),
  type: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  format: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.string()).optional(),
  parent_id: z.string().optional(),
  parent_table: z.string().optional(),
  space_id: z.string().optional(),
});

export type NotionBlock = z.infer<typeof blockSchema>;

export type NotionBlockMap = Map<string, NotionBlock>;

const responseSchema = z.object({
  cursor: z.object({ stack: z.array(z.unknown()) }).optional(),
  recordMap: z
    .object({
      block: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/**
 * Records come as `{ value: <block>, role }` or, in newer responses,
 * `{ value: { value: <block>, role } }`. A block the anonymous reader may not
 * see comes with no usable value at all and is dropped.
 */
function unwrapBlockRecord(record: unknown): NotionBlock | null {
  if (typeof record !== "object" || record === null || !("value" in record)) {
    return null;
  }
  let value: unknown = (record as { value: unknown }).value;
  if (typeof value === "object" && value !== null && !("id" in value) && "value" in value) {
    value = (value as { value: unknown }).value;
  }
  const parsed = blockSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Load every block of a published Notion page, following the endpoint's chunk
 * cursor. Throws on HTTP errors (`HttpFetchError`), oversized responses
 * (`ContentTooLargeError`, bounded by the saved-article size limit across all
 * chunks), timeouts, and malformed responses.
 *
 * An unpublished or nonexistent page is not an error here: the endpoint
 * answers 200 with no readable records, so the returned map simply lacks the
 * page block and the renderer reports "nothing to render".
 */
export async function fetchNotionPageBlocks(pageId: string): Promise<NotionBlockMap> {
  const maxBytes = usageLimitsConfig.maxSavedArticleSizeBytes;
  const blocks: NotionBlockMap = new Map();
  let cursor: unknown = { stack: [] };
  let bytesRead = 0;

  for (let chunkNumber = 0; chunkNumber < MAX_CHUNKS; chunkNumber++) {
    const response = await fetchWithSsrfProtection(LOAD_PAGE_CHUNK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        pageId,
        limit: CHUNK_LIMIT,
        cursor,
        chunkNumber,
        verticalColumns: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new HttpFetchError(response.status, response.statusText, LOAD_PAGE_CHUNK_URL);
    }

    const text = await readResponseWithSizeLimit(
      response,
      maxBytes - bytesRead,
      LOAD_PAGE_CHUNK_URL
    );
    bytesRead += Buffer.byteLength(text);

    const parsed = responseSchema.parse(JSON.parse(text));
    for (const [id, record] of Object.entries(parsed.recordMap?.block ?? {})) {
      const block = unwrapBlockRecord(record);
      if (block && !blocks.has(id)) {
        blocks.set(id, block);
      }
    }

    const stack = parsed.cursor?.stack ?? [];
    if (stack.length === 0) {
      return blocks;
    }
    cursor = parsed.cursor;
  }

  logger.warn("Notion page exceeded the chunk limit; rendering what was loaded", {
    pageId,
    blocks: blocks.size,
    maxChunks: MAX_CHUNKS,
  });
  return blocks;
}
