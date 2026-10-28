/**
 * How large an upload may be, shared by the server's checks, the clients'
 * checks before sending (the web's Upload dialog, the native app) and the
 * request-body limit, so they can't disagree.
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

/** The largest file any upload accepts by default: the largest request body is sized for it. */
export const MAX_UPLOAD_FILE_BYTES = maxEbookUploadBytes(DEFAULT_MAX_SAVED_ARTICLE_SIZE_BYTES);

/**
 * The most of a request body Next's proxy passes on (`proxyClientMaxBodySize`,
 * Next's default): it buffers every body it sees, cutting off the rest. So the
 * upload endpoints ({@link isUploadPath}) bypass it, and the proxy rejects any
 * other request declaring more.
 */
export const PROXY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * The largest body an upload endpoint reads: {@link MAX_UPLOAD_FILE_BYTES}
 * base64-encoded, with room for the rest of the JSON around it.
 */
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_FILE_BYTES / 3) * 4 + 64 * 1024;

/**
 * The procedures that take a file. The web client sends them unbatched, so
 * each has a path of its own for the proxy to skip.
 */
export const UPLOAD_PROCEDURES: ReadonlySet<string> = new Set([
  "collections.importEbook",
  "saved.uploadFile",
]);

const UPLOAD_PATHS: ReadonlySet<string> = new Set([
  ...[...UPLOAD_PROCEDURES].map((procedure) => `/api/trpc/${procedure}`),
  "/api/v1/collections/import-ebook",
  "/api/v1/saved/upload",
]);

/** Whether a request path is an upload endpoint's, which `src/proxy.ts`'s matcher skips. */
export function isUploadPath(pathname: string): boolean {
  return UPLOAD_PATHS.has(pathname);
}
