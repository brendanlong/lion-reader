/**
 * Worker thread entry point for CPU-intensive operations.
 *
 * This file runs inside a piscina worker thread. It imports the real
 * (synchronous) implementation of parseFeed and dispatches based on the
 * request type. (Content cleaning left the pool when extraction went native —
 * see cleanContentInWorker in pool.ts.)
 *
 * The default export is called by piscina for each task.
 */

import { parseFeed } from "@/server/feed/parser";
import { SANITIZER_VERSION } from "@/server/html/sanitize";
import { workerRequestSchema, serializeParsedFeed } from "./types";
import type { SerializedParsedFeed } from "./types";

type TaskResult = SerializedParsedFeed | { version: number };

export default function handleTask(raw: unknown): TaskResult {
  const request = workerRequestSchema.parse(raw);

  switch (request.type) {
    case "parseFeed":
      return serializeParsedFeed(parseFeed(request.content));

    // Report the sanitizer version this worker runs (read from the shared
    // native module at runtime, so it always matches the main process; the
    // probe now mainly proves the worker loads and speaks the protocol).
    case "sanitizerVersion":
      return { version: SANITIZER_VERSION };
  }
}
