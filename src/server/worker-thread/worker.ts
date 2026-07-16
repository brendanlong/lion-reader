/**
 * Worker thread entry point for CPU-intensive operations.
 *
 * This file runs inside a piscina worker thread. It imports the real
 * (synchronous) implementations of cleanContent and parseFeed and
 * dispatches based on the request type.
 *
 * The default export is called by piscina for each task.
 */

import { cleanContent } from "@/server/feed/content-cleaner";
import { parseFeed } from "@/server/feed/parser";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "@/server/html/sanitize";
import { workerRequestSchema, serializeParsedFeed } from "./types";
import type { CleanedContent as RawCleanedContent } from "@/server/feed/content-cleaner";
import type { CleanedContent, SerializedParsedFeed } from "./types";

type TaskResult = CleanedContent | SerializedParsedFeed | { version: number } | null;

export default function handleTask(raw: unknown): TaskResult {
  const request = workerRequestSchema.parse(raw);

  switch (request.type) {
    case "cleanContent": {
      const cleaned: RawCleanedContent | null = cleanContent(request.html, request.options);
      if (!cleaned) return null;
      // Fuse the sanitize into this same task so a caller that persists the
      // cleaned content (e.g. saved articles) doesn't ship the string back
      // across the thread boundary a second time just to sanitize it.
      if (request.sanitizeCleaned) {
        return { ...cleaned, contentSanitized: sanitizeEntryHtml(cleaned.content) };
      }
      return cleaned;
    }

    case "parseFeed":
      return serializeParsedFeed(parseFeed(request.content));

    // Report the sanitizer version this worker runs (read from the shared
    // native module at runtime, so it always matches the main process; the
    // probe now mainly proves the worker loads and speaks the protocol).
    case "sanitizerVersion":
      return { version: SANITIZER_VERSION };
  }
}
