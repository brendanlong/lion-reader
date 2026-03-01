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
import { workerRequestSchema, serializeParsedFeed } from "./types";
import type { CleanedContent } from "@/server/feed/content-cleaner";
import type { SerializedParsedFeed } from "./types";

export default function handleTask(raw: unknown): CleanedContent | SerializedParsedFeed | null {
  const request = workerRequestSchema.parse(raw);

  switch (request.type) {
    case "cleanContent":
      return cleanContent(request.html, request.options) ?? null;

    case "parseFeed":
      return serializeParsedFeed(parseFeed(request.content));
  }
}
