/**
 * Moves the Google Docs images that saves before #2212 stored under
 * `google-docs/` in the public bucket, where nothing deletes them, to their
 * entries' objects prefixes, then deletes them (#2107):
 *
 *   pnpm exec tsx scripts/move-google-docs-images.ts rewrite [--dry-run] [--after <entry id>] [--batch-size 1000] [--pause-ms 0]
 *   pnpm exec tsx scripts/move-google-docs-images.ts delete [--dry-run] [--batch-size 1000] [--pause-ms 0]
 *
 * Both run against production: DATABASE_URL and the STORAGE_* variables.
 *
 * `rewrite` walks `entries` in id order, reading `--batch-size` ids per query.
 * For a saved article or newsletter whose content links such an image, it
 * stores the image under the entry's prefix exactly as a save today would (the
 * URL pass hash-names it; one that pass doesn't store stays inline), relinks it
 * in every column, and bumps `updated_at` so synced clients download the new
 * links. An entry changed since it was read is skipped, for a rerun; one
 * deleted meanwhile has its new copies deleted. A feed entry's full content
 * has those images dropped instead, as a fetch today leaves them out: feed
 * entries have no prefix and keep no images we fetched (`src/server/CLAUDE.md`,
 * "Stored Objects"). A link to a missing object is left alone. It's
 * idempotent: rerun it, or resume with `--after` from the last id it logged.
 *
 * `delete` scans every entry for any mention of a `google-docs/` key, then
 * deletes each object there that nothing mentions, so it never breaks an entry
 * `rewrite` hasn't reached. `delete --dry-run` reporting `kept: 0, deleted: 0`
 * means it's done.
 */

import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { sql, type SQL } from "drizzle-orm";
import { parseHTML } from "linkedom";
import type { db as dbType } from "../src/server/db";
import { rewriteContentUrls } from "../src/server/feed/content-cleaner";
import { inlineImageUrlPrefix, storeExtractedImages } from "../src/server/services/inline-images";
import { entryObjectsPrefix } from "../src/server/services/stored-objects";
import {
  deleteObject,
  deleteObjectsWithPrefix,
  getPublicObject,
  isStorageAvailable,
  listKeys,
} from "../src/server/storage/s3";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const GOOGLE_DOCS_PREFIX = "google-docs/";

/**
 * A link to one of those images, `google-docs/{docId}/{uuid}.{ext}`, under any
 * public URL base the bucket has had; group 1 is its key. A link that only
 * looks like one names no object, and is left alone as missing.
 */
const LINK_PATTERN =
  /https?:\/\/[^\s"'<>()]+?\/(google-docs\/[\w-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+)/g;

/** Cheap SQL prefilter for {@link LINK_PATTERN}. */
const LIKE_LINK = `%/${GOOGLE_DOCS_PREFIX}%`;

/**
 * Looser than {@link LINK_PATTERN}, for what `delete` keeps: a key in any
 * case, percent-encoded or without a URL around it.
 */
const KEY_MENTION =
  /google-docs(?:\/|%2f)([\w-]+)(?:\/|%2f)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z]+)/gi;

/** SQL prefilter for {@link KEY_MENTION}. */
const ILIKE_MENTION = "%google-docs%";

interface BatchOptions {
  batchSize?: number;
  pauseMs?: number;
  dryRun?: boolean;
  log?: (message: string) => void;
}

function linkedKeys(text: string | null): string[] {
  return text === null ? [] : [...text.matchAll(LINK_PATTERN)].map((match) => match[1]);
}

/** Consecutive ranges of `--batch-size` entry ids after `after`, in id order. */
async function* idWindows(
  db: typeof dbType,
  { after, batchSize, pauseMs }: { after: string; batchSize: number; pauseMs: number }
): AsyncGenerator<{ after: string; through: string }> {
  let cursor = after;
  for (;;) {
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM (
        SELECT id FROM entries WHERE id > ${cursor}::uuid ORDER BY id LIMIT ${batchSize}
      ) w
      ORDER BY id DESC
      LIMIT 1
    `);
    if (rows.length === 0) return;
    yield { after: cursor, through: rows[0].id };
    cursor = rows[0].id;
    await sleep(pauseMs);
  }
}

function anyLike(columns: SQL[], pattern: string): SQL {
  return sql.join(
    columns.map((column) => sql`${column} ILIKE ${pattern}`),
    sql` OR `
  );
}

/** `html` without the `<img>`s linking `google-docs/` objects. */
function withoutLinkedImages(html: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  for (const img of document.querySelectorAll("img")) {
    if (linkedKeys(img.getAttribute("src")).length > 0) img.remove();
  }
  return document.body.innerHTML;
}

interface LinkingRow extends Record<string, unknown> {
  id: string;
  type: "web" | "email" | "saved";
  /** The user whose objects prefix the entry's images go under; null for a feed's entry. */
  user_id: string | null;
  content_original: string | null;
  content_cleaned: string | null;
  full_content_cleaned: string | null;
}

/**
 * Stores an image under `objectsPrefix` as the write-time URL pass would had a
 * save inlined it, returning the `src` that replaces its link: its stored URL,
 * or the `data:` URI when the pass keeps it inline.
 */
async function storeAsSaveWould(
  objectsPrefix: string,
  image: { data: Buffer; contentType: string | null },
  dryRun: boolean
): Promise<string> {
  const mediaType = image.contentType?.split(";")[0].trim() ?? "";
  const dataUri = `data:${/^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream"};base64,${image.data.toString("base64")}`;
  const imageUrlPrefix = inlineImageUrlPrefix(objectsPrefix);
  if (imageUrlPrefix === null) throw new Error("Object storage isn't configured");
  const { images } = rewriteContentUrls(`<img src="${dataUri}">`, null, { imageUrlPrefix });
  if (images.length === 0) return dataUri;
  if (!dryRun) await storeExtractedImages(objectsPrefix, images);
  return `${imageUrlPrefix}${images[0].name}`;
}

interface RewriteResult {
  /** Entries whose links now point under their own prefix. */
  rewritten: number;
  /** Feed entries whose full content had the images dropped. */
  dropped: number;
  /** Entries changed between being read and written; rerun to pick them up. */
  skipped: number;
  /** Links to objects that don't exist, left as they were. */
  missingLinks: number;
  /** The last entry id scanned, for `--after`. */
  through: string;
}

/**
 * Relinks every entry's `google-docs/` images to copies under the entry's
 * prefix, or clears a feed entry's full content that links them.
 */
export async function rewriteGoogleDocsLinks(
  db: typeof dbType,
  {
    after = NIL_UUID,
    batchSize = 1000,
    pauseMs = 0,
    dryRun = false,
    log = () => {},
  }: BatchOptions & { after?: string } = {}
): Promise<RewriteResult> {
  if (!isStorageAvailable()) throw new Error("Object storage isn't configured");
  const result: RewriteResult = {
    rewritten: 0,
    dropped: 0,
    skipped: 0,
    missingLinks: 0,
    through: after,
  };

  for await (const window of idWindows(db, { after, batchSize, pauseMs })) {
    const { rows } = await db.execute<LinkingRow>(sql`
      SELECT e.id, e.type, COALESCE(e.owner_user_id, s.user_id) AS user_id,
             e.content_original, e.content_cleaned, e.full_content_cleaned
      FROM entries e
      LEFT JOIN subscriptions s ON s.id = e.owner_subscription_id
      WHERE e.id > ${window.after}::uuid AND e.id <= ${window.through}::uuid
        AND (
          e.full_content_cleaned LIKE ${LIKE_LINK}
          -- A feed's own content is the publisher's, not ours to relink.
          OR (e.type <> 'web' AND (e.content_original LIKE ${LIKE_LINK} OR e.content_cleaned LIKE ${LIKE_LINK}))
        )
      ORDER BY e.id
    `);

    for (const row of rows) {
      if (row.user_id === null) {
        if (row.full_content_cleaned === null) continue;
        const dropped = withoutLinkedImages(row.full_content_cleaned);
        if (linkedKeys(dropped).length === linkedKeys(row.full_content_cleaned).length) continue;
        if (dryRun) {
          result.dropped++;
          continue;
        }
        const updated = await db.execute(sql`
          UPDATE entries SET full_content_cleaned = ${dropped}, updated_at = now()
          WHERE id = ${row.id}::uuid
            AND full_content_cleaned IS NOT DISTINCT FROM ${row.full_content_cleaned}
        `);
        if (updated.rowCount === 1) result.dropped++;
        else {
          result.skipped++;
          log(`skipped ${row.id}: changed while being rewritten`);
        }
        continue;
      }

      const objectsPrefix = entryObjectsPrefix(row.user_id, row.id);
      const keys = new Set([
        ...linkedKeys(row.content_original),
        ...linkedKeys(row.content_cleaned),
        ...linkedKeys(row.full_content_cleaned),
      ]);
      const srcs = new Map<string, string>();
      for (const key of keys) {
        const image = await getPublicObject(key);
        if (image) srcs.set(key, await storeAsSaveWould(objectsPrefix, image, dryRun));
        else {
          result.missingLinks++;
          log(`${row.id} links missing ${key}; left alone`);
        }
      }
      if (srcs.size === 0) continue;
      if (dryRun) {
        result.rewritten++;
        continue;
      }

      const relink = (text: string | null): string | null =>
        text?.replace(LINK_PATTERN, (link, key: string) => srcs.get(key) ?? link) ?? null;
      const updated = await db.execute(sql`
        UPDATE entries
        SET content_original = ${relink(row.content_original)},
            content_cleaned = ${relink(row.content_cleaned)},
            full_content_cleaned = ${relink(row.full_content_cleaned)},
            updated_at = now()
        WHERE id = ${row.id}::uuid
          AND content_original IS NOT DISTINCT FROM ${row.content_original}
          AND content_cleaned IS NOT DISTINCT FROM ${row.content_cleaned}
          AND full_content_cleaned IS NOT DISTINCT FROM ${row.full_content_cleaned}
      `);
      if (updated.rowCount === 1) {
        result.rewritten++;
        continue;
      }
      result.skipped++;
      log(`skipped ${row.id}: changed while being rewritten`);
      // Deleted meanwhile, maybe after its deletion job ran: nothing else
      // would delete the copies just stored.
      const exists = await db.execute(sql`SELECT 1 FROM entries WHERE id = ${row.id}::uuid`);
      if (exists.rows.length === 0) await deleteObjectsWithPrefix("public", objectsPrefix);
    }

    result.through = window.through;
    log(`through ${window.through}: ${JSON.stringify(result)}`);
  }
  return result;
}

interface DeleteResult {
  /** Distinct `google-docs/` keys some entry still links, whether or not they exist. */
  linkedKeys: number;
  /** Objects left because an entry links them. */
  kept: number;
  /** Objects deleted (or, in a dry run, that would be). */
  deleted: number;
}

/** Deletes every object under `google-docs/` that no entry links. */
export async function deleteUnlinkedGoogleDocsImages(
  db: typeof dbType,
  { batchSize = 1000, pauseMs = 0, dryRun = false, log = () => {} }: BatchOptions = {}
): Promise<DeleteResult> {
  if (!isStorageAvailable()) throw new Error("Object storage isn't configured");

  // Every text column of every entry, not only what `rewrite` relinks: a
  // mention anywhere keeps its object.
  const linked = new Set<string>();
  for await (const window of idWindows(db, { after: NIL_UUID, batchSize, pauseMs })) {
    const { rows } = await db.execute<Record<string, string | null>>(sql`
      SELECT content_original, content_cleaned, full_content_cleaned, summary, image_url, url
      FROM entries
      WHERE id > ${window.after}::uuid AND id <= ${window.through}::uuid
        AND (${anyLike([sql`content_original`, sql`content_cleaned`, sql`full_content_cleaned`, sql`summary`, sql`image_url`, sql`url`], ILIKE_MENTION)})
    `);
    for (const row of rows) {
      for (const text of Object.values(row)) {
        for (const [, docId, uuid, extension] of text?.matchAll(KEY_MENTION) ?? []) {
          linked.add(
            `${GOOGLE_DOCS_PREFIX}${docId}/${uuid.toLowerCase()}.${extension.toLowerCase()}`
          );
        }
      }
    }
  }
  log(`entries link ${linked.size} google-docs/ keys`);

  const result: DeleteResult = { linkedKeys: linked.size, kept: 0, deleted: 0 };
  for await (const keys of listKeys("public", GOOGLE_DOCS_PREFIX)) {
    for (const key of keys) {
      if (linked.has(key)) {
        result.kept++;
        continue;
      }
      if (!dryRun) await deleteObject("public", key);
      result.deleted++;
    }
    log(JSON.stringify(result));
  }
  return result;
}

function parseArgs(argv: string[]): {
  command: "rewrite" | "delete";
  options: BatchOptions & { after?: string };
} {
  const [command, ...rest] = argv;
  if (command !== "rewrite" && command !== "delete") {
    throw new Error("Usage: move-google-docs-images.ts rewrite|delete [options]");
  }
  const options: BatchOptions & { after?: string } = { log: (m) => console.log(m) };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--batch-size") options.batchSize = Number(rest[++i]);
    else if (arg === "--pause-ms") options.pauseMs = Number(rest[++i]);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--after" && command === "rewrite") options.after = rest[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    options.batchSize !== undefined &&
    !(Number.isInteger(options.batchSize) && options.batchSize > 0)
  ) {
    throw new Error("--batch-size must be a positive integer");
  }
  if (options.pauseMs !== undefined && !(options.pauseMs >= 0)) {
    throw new Error("--pause-ms must be a non-negative number");
  }
  return { command, options };
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const { db, pool } = await import("../src/server/db");
  const { storageConfig } = await import("../src/server/config/env");
  const database = new URL(process.env.DATABASE_URL ?? "");
  console.log(
    `${command}${options.dryRun ? " (dry run)" : ""}: database ${database.host}${database.pathname}, bucket ${storageConfig.bucket} at ${storageConfig.endpoint ?? "AWS"}`
  );
  try {
    const started = Date.now();
    const result =
      command === "rewrite"
        ? await rewriteGoogleDocsLinks(db, options)
        : await deleteUnlinkedGoogleDocsImages(db, options);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s:`, JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
