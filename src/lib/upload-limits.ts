/**
 * How large an upload may be, shared by the server's checks, what it tells
 * the web's Upload dialog (`saved.uploadLimits`), the native app's default and
 * the request-body limit, so they can't disagree.
 */

/**
 * The largest saved article, and so the largest uploaded file that becomes
 * one, unless a server sets its own (`MAX_SAVED_ARTICLE_SIZE_BYTES`).
 */
export const DEFAULT_MAX_SAVED_ARTICLE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * An uploaded ebook, as a multiple of the saved-article limit. Its images go
 * to object storage and each chapter is held to the article limit, so what
 * bounds the file is the app server's memory: the upload is in it several
 * times over (the request body, the decoded file, the archive's inflated
 * entries).
 */
const EBOOK_UPLOAD_FACTOR = 4;

export function maxEbookUploadBytes(maxSavedArticleBytes: number): number {
  return maxSavedArticleBytes * EBOOK_UPLOAD_FACTOR;
}

/**
 * The most of a request body Next's proxy passes on (`proxyClientMaxBodySize`,
 * Next's default): it buffers every body it sees, cutting off the rest. So the
 * upload endpoints ({@link UPLOAD_PATHS}) bypass it, and the proxy rejects any
 * other request declaring more.
 */
export const PROXY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * The largest body an upload endpoint reads: a file of `maxFileBytes`
 * base64-encoded, with room for the rest of the JSON around it.
 */
export function maxUploadBodyBytes(maxFileBytes: number): number {
  return Math.ceil(maxFileBytes / 3) * 4 + 64 * 1024;
}

type FileLimit = (maxSavedArticleBytes: number) => number;

/** The largest file each procedure that takes one takes. */
export const UPLOAD_FILE_LIMITS = {
  "collections.importEbook": maxEbookUploadBytes,
  "saved.uploadFile": (maxSavedArticleBytes) => maxSavedArticleBytes,
} satisfies Record<string, FileLimit>;

/**
 * The procedures that take a file. The web client sends them unbatched, so
 * each has a path of its own for the proxy to skip.
 */
export const UPLOAD_PROCEDURES: ReadonlySet<string> = new Set(Object.keys(UPLOAD_FILE_LIMITS));

/**
 * The upload endpoints, which `src/proxy.ts`'s matcher skips, each with the
 * largest file it takes given the saved-article limit.
 */
export const UPLOAD_PATHS: ReadonlyMap<string, FileLimit> = new Map<string, FileLimit>([
  ...Object.entries(UPLOAD_FILE_LIMITS).map(([procedure, limit]): [string, FileLimit] => [
    `/api/trpc/${procedure}`,
    limit,
  ]),
  ["/api/v1/collections/import-ebook", UPLOAD_FILE_LIMITS["collections.importEbook"]],
  ["/api/v1/saved/upload", UPLOAD_FILE_LIMITS["saved.uploadFile"]],
]);
