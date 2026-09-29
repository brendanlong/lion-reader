/**
 * `.docx` decompression budget: mammoth inflates every part it reads with no cap,
 * so a small upload that inflates past the budget must be rejected before it
 * runs — including one whose ZIP headers understate how large it really is.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { convertUploadedFile } from "@/server/file/process-upload";
import { usageLimitsConfig } from "@/server/config/env";
import { buildMinimalDocx, buildZip } from "../utils/docx";

// Default budget is 10x the saved-article limit; comfortably past it.
const bombText = "a".repeat(usageLimitsConfig.maxSavedArticleSizeBytes * 11);

async function conversionError(docx: Buffer): Promise<unknown> {
  return convertUploadedFile(docx, "bomb.docx").then(
    () => null,
    (error: unknown) => error
  );
}

describe("docx decompression budget", () => {
  it("converts an ordinary document", async () => {
    const docx = buildMinimalDocx({ paragraphs: ["Hello, world."] });
    const converted = await convertUploadedFile(docx, "ok.docx");
    expect(converted.html).toContain("Hello, world.");
  });

  it("rejects a document that inflates past the budget", async () => {
    const docx = buildMinimalDocx({ paragraphs: [bombText] });
    expect(docx.length).toBeLessThan(usageLimitsConfig.maxSavedArticleSizeBytes);

    const error = await conversionError(docx);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).message).toMatch(/exceeds the maximum size/);
  });

  it("rejects a bomb whose headers declare a tiny size", async () => {
    // Only the bomb lies: a small part declaring the wrong size would be
    // rejected by jszip's own end-of-entry length check before the bomb.
    const docx = buildZip({ "word/document.xml": bombText }, { declaredUncompressedSize: 1024 });

    const error = await conversionError(docx);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).message).toMatch(/exceeds the maximum size/);
  });
});
