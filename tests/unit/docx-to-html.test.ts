/**
 * `.docx` conversion memory bounds. mammoth builds a full DOM of the document
 * and inlines every image reference separately, so a few-KB upload can cost
 * gigabytes; every way of getting there must end in CONTENT_TOO_LARGE, not an
 * out-of-memory crash of the whole process.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { convertUploadedFile } from "@/server/file/process-upload";
import { usageLimitsConfig } from "@/server/config/env";
import { getAppErrorCode } from "@/server/trpc/errors";
import { buildMinimalDocx, buildZip, buildDocxWithRepeatedImage } from "../utils/docx";

const MB = 1024 * 1024;

async function conversionError(docx: Buffer): Promise<unknown> {
  return convertUploadedFile(docx, "bomb.docx").then(
    () => null,
    (error: unknown) => error
  );
}

async function expectContentTooLarge(docx: Buffer, message: RegExp): Promise<void> {
  const error = await conversionError(docx);
  expect(error).toBeInstanceOf(TRPCError);
  expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
  expect((error as TRPCError).message).toMatch(message);
}

describe("docx conversion bounds", () => {
  it("converts an ordinary document", async () => {
    const docx = buildMinimalDocx({ paragraphs: ["Hello, world."] });
    const converted = await convertUploadedFile(docx, "ok.docx");
    expect(converted.html).toContain("Hello, world.");
  });

  it("converts a long document of ordinary prose", async () => {
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const docx = buildMinimalDocx({ paragraphs: Array(4000).fill(paragraph) });
    const converted = await convertUploadedFile(docx, "long.docx");
    expect(converted.html.length).toBeGreaterThan(MB);
  });

  it("rejects XML that inflates past the text budget without converting it", async () => {
    const text = "a".repeat(usageLimitsConfig.maxSavedArticleSizeBytes * 3);
    const docx = buildMinimalDocx({ paragraphs: [text] });
    expect(docx.length).toBeLessThan(usageLimitsConfig.maxSavedArticleSizeBytes);

    await expectContentTooLarge(docx, /Decompressed \.docx text/);
  });

  it("rejects a bomb whose headers declare a tiny size", async () => {
    // Only the bomb lies: a small part declaring the wrong size would be
    // rejected by jszip's own end-of-entry length check before the bomb.
    const text = "a".repeat(usageLimitsConfig.maxSavedArticleSizeBytes * 3);
    const docx = buildZip({ "word/document.xml": text }, { declaredUncompressedSize: 1024 });

    await expectContentTooLarge(docx, /Decompressed \.docx text/);
  });

  it("rejects dense markup that fits the text budget but not the worker's memory", async () => {
    // ~5MB of one-character paragraphs: well inside the XML budget, but mammoth
    // needs over a gigabyte of heap to build its DOM.
    const docx = buildMinimalDocx({ paragraphs: Array(150_000).fill("x") });

    await expectContentTooLarge(docx, /too large or complex/);
  }, 30_000);

  it("rejects one image referenced many times past the image budget", async () => {
    // Stored once, but mammoth reads and encodes it again for every reference.
    const docx = buildDocxWithRepeatedImage({ imageBytes: 2 * MB, references: 50 });
    expect(docx.length).toBeLessThan(64 * 1024);

    await expectContentTooLarge(docx, /Document images/);
  });

  it("inlines images within the budget", async () => {
    const docx = buildDocxWithRepeatedImage({ imageBytes: 1024, references: 2 });
    const converted = await convertUploadedFile(docx, "images.docx");
    expect(converted.html.match(/<img src="data:image\/png;base64,/g)).toHaveLength(2);
  });

  it("converts uploads that arrive together", async () => {
    const docs = ["one", "two", "three"].map((word) =>
      convertUploadedFile(buildMinimalDocx({ paragraphs: [word] }), `${word}.docx`)
    );
    const converted = await Promise.all(docs);
    expect(converted.map((c) => c.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
  });
});
