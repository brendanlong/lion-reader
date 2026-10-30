import { TRPCError } from "@trpc/server";
import type { SavedArticleContent, UrlPlugin, UserAuthMode, UserFetchContext } from "./types";
import {
  extractDocId,
  extractTabId,
  fetchGoogleDocsFromUrl,
  fetchPrivateGoogleDoc,
  normalizeGoogleDocsUrl,
  type GoogleDocsContent,
} from "@/server/google/docs";
import {
  getGoogleDocsGrant,
  getValidGoogleToken,
  GOOGLE_DOCS_SCOPES,
} from "@/server/google/tokens";
import { getAppErrorCode } from "@/server/errors";
import { logger } from "@/lib/logger";

/**
 * Google Docs plugin using the Google Docs API for content extraction.
 *
 * Public documents are fetched with the service account (`fetchContent`),
 * private ones with the saving user's linked Google account
 * (`fetchContentAsUser`).
 */
export const googleDocsPlugin: UrlPlugin = {
  name: "google-docs",
  hosts: ["docs.google.com"],

  matchUrl(url: URL): boolean {
    // Match /document/d/{docId} URLs
    return /^\/document\/d\/[a-zA-Z0-9_-]+/.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL, options): Promise<SavedArticleContent | null> {
        try {
          // Validates it's a Google Docs URL: extractDocId returns null when it isn't.
          const docId = extractDocId(url.href);
          if (!docId) {
            return null;
          }

          // Fetch the document content
          const content = await fetchGoogleDocsFromUrl(url.href, options);
          if (!content) {
            return null;
          }

          // Normalize the URL to use as canonical
          const canonical = normalizeGoogleDocsUrl(url.href);
          const title = content.title || null;

          return {
            // Bare fragment, not a wrapped document: with skipReadability the
            // html is stored as the article body, and the read-path sanitizer
            // drops <title> tags but keeps their text — a wrapped document
            // would leak the doc title as stray text above the content.
            html: content.html,
            title,
            canonicalUrl: canonical,
          };
        } catch (error) {
          if (getAppErrorCode(error) === "CONTENT_TOO_LARGE") {
            throw error;
          }
          logger.warn("Failed to fetch Google Docs content", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      async fetchContentAsUser(
        url: URL,
        user: UserFetchContext
      ): Promise<SavedArticleContent | null> {
        const doc = await fetchPrivateGoogleDocWithAuth(user.userId, url.href, user.authMode);
        if (!doc) return null;
        logger.debug("Successfully fetched private Google Docs content", {
          userId: user.userId,
          docId: doc.docId,
          title: doc.title,
        });
        return { html: doc.html, title: doc.title };
      },

      // Only the `tab` query parameter identifies content (`usp=sharing`, `pli`
      // etc. don't), and a fragment only points at a heading within the doc.
      normalizeUrl(url: URL): URL {
        const normalized = new URL(normalizeGoogleDocsUrl(url.href));
        normalized.hash = "";
        return normalized;
      },

      skipReadability: true, // Google Docs API content is already clean HTML
      siteName: "Google Docs",
    },
  },
};

/**
 * Human-readable messages for the `"non-interactive"` auth mode (Wallabag, MCP,
 * and other API surfaces that can't run an in-page consent dance). The
 * `"interactive"` mode instead throws the machine-readable NEEDS_* codes the web
 * UI matches — both share the same 4xx classification, so Wallabag's
 * `clientErrorResponse` and MCP surface either one cleanly.
 */
const NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES = {
  signin:
    "This is a private Google Doc. To save private Google Docs from the API, first link your Google account and authorize Google Docs access in the Lion Reader web app (by saving a Google Doc there once).",
  permission:
    "This is a private Google Doc. To save it from the API, grant Google Docs access in the Lion Reader web app first (by saving a Google Doc there once).",
  reauth:
    "Your Google authorization has expired. Please reconnect your Google account in the Lion Reader web app, then try saving again.",
} as const;

/**
 * Fetch a private Google Doc with the user's stored OAuth credentials.
 *
 * When no Google account is linked or the required scopes aren't granted, throws
 * a 4xx error. The `mode` only controls the *message*:
 * - `"interactive"` throws the machine-readable NEEDS_GOOGLE_SIGNIN /
 *   NEEDS_DOCS_PERMISSION / NEEDS_GOOGLE_REAUTH codes the web UI turns into
 *   consent prompts.
 * - `"non-interactive"` throws the same UNAUTHORIZED/FORBIDDEN classification
 *   with a human-readable message telling API clients to complete the one-time
 *   authorization in the web app.
 *
 * Returns null (caller falls back to a plain HTML fetch) when the doc can't be
 * fetched for other reasons.
 */
async function fetchPrivateGoogleDocWithAuth(
  userId: string,
  normalizedUrl: string,
  mode: UserAuthMode
): Promise<GoogleDocsContent | null> {
  const docId = extractDocId(normalizedUrl);
  if (!docId) {
    return null;
  }
  const tabId = extractTabId(normalizedUrl);

  const grant = await getGoogleDocsGrant(userId);
  if (grant.status === "unlinked") {
    logger.debug("User needs to sign in with Google for private docs", {
      userId,
      url: normalizedUrl,
      mode,
    });
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message:
        mode === "interactive"
          ? "NEEDS_GOOGLE_SIGNIN"
          : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.signin,
      cause: {
        code: "NEEDS_GOOGLE_SIGNIN",
        details: {
          url: normalizedUrl,
        },
      },
    });
  }

  if (grant.status === "missing-scopes") {
    logger.debug("User needs to grant Google Docs permissions", {
      userId,
      url: normalizedUrl,
      mode,
    });
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        mode === "interactive"
          ? "NEEDS_DOCS_PERMISSION"
          : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.permission,
      cause: {
        code: "NEEDS_DOCS_PERMISSION",
        details: {
          url: normalizedUrl,
          scopes: GOOGLE_DOCS_SCOPES,
        },
      },
    });
  }

  try {
    logger.debug("Attempting private Google Docs fetch with user OAuth", { userId, docId });
    const accessToken = await getValidGoogleToken(grant.account);
    return await fetchPrivateGoogleDoc(docId, accessToken, tabId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "GOOGLE_TOKEN_INVALID" || error.message === "GOOGLE_NEEDS_REAUTH")
    ) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message:
          mode === "interactive"
            ? "NEEDS_GOOGLE_REAUTH"
            : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.reauth,
        cause: {
          code: "NEEDS_GOOGLE_REAUTH",
          details: {
            url: normalizedUrl,
          },
        },
      });
    } else if (error instanceof Error && error.message === "GOOGLE_PERMISSION_DENIED") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You don't have permission to access this Google Doc.",
        cause: { code: "GOOGLE_PERMISSION_DENIED" },
      });
    }
    if (getAppErrorCode(error) === "CONTENT_TOO_LARGE") {
      throw error;
    }
    // Other errors - fall back to a plain fetch
    logger.warn("Failed to fetch private Google Doc with OAuth", {
      userId,
      docId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
