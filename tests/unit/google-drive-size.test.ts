/**
 * Drive `.docx` downloads are held to the saved-article size limit while
 * streaming, and an oversized one reaches the user as CONTENT_TOO_LARGE rather
 * than a generic fetch failure.
 */

import { describe, it, expect } from "vitest";
import { readDriveFileBody } from "@/server/google/drive";
import { usageLimitsConfig } from "@/server/config/env";
import { getAppErrorCode } from "@/server/trpc/errors";

const DOWNLOAD_URL = "https://www.googleapis.com/drive/v3/files/abc?alt=media";

/** A body streamed in 64KB chunks with no Content-Length, like a chunked download. */
function streamedResponse(totalBytes: number): Response {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024);
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunk.length, totalBytes - sent);
        controller.enqueue(chunk.subarray(0, size));
        sent += size;
      },
    })
  );
}

describe("readDriveFileBody", () => {
  it("returns a body within the limit", async () => {
    const body = await readDriveFileBody(streamedResponse(100 * 1024), DOWNLOAD_URL);
    expect(body.length).toBe(100 * 1024);
  });

  it("rejects a streamed body past the limit as CONTENT_TOO_LARGE", async () => {
    const error = await readDriveFileBody(
      streamedResponse(usageLimitsConfig.maxSavedArticleSizeBytes + 1),
      DOWNLOAD_URL
    ).catch((e: unknown) => e);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
  });

  it("rejects a declared Content-Length past the limit without reading", async () => {
    const response = new Response("small", {
      headers: { "content-length": String(usageLimitsConfig.maxSavedArticleSizeBytes + 1) },
    });
    const error = await readDriveFileBody(response, DOWNLOAD_URL).catch((e: unknown) => e);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
  });
});
