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
 * The largest request body the app server reads: {@link MAX_UPLOAD_FILE_BYTES}
 * base64-encoded, with room for the rest of the JSON around it. Next's proxy
 * passes on only this much of any body (`proxyClientMaxBodySize`), cutting off
 * the rest, so a request declaring more is rejected before anything parses it.
 */
export const MAX_REQUEST_BODY_BYTES = Math.ceil(MAX_UPLOAD_FILE_BYTES / 3) * 4 + 64 * 1024;
