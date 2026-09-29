/**
 * `.docx` conversion memory bounds. mammoth builds a full DOM of the document
 * and inlines every image reference separately, so a few-KB upload can cost
 * gigabytes; every way of getting there must end in CONTENT_TOO_LARGE, not an
 * out-of-memory crash of the whole process.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { convertUploadedFile } from "@/server/file/process-upload";
import { createDocxConverter } from "@/server/file/docx-to-html";
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

  it("holds the main document to the text budget whatever it is named", async () => {
    // mammoth follows the officeDocument relationship, so `document.bin` is
    // parsed just like `document.xml`.
    const text = "a".repeat(usageLimitsConfig.maxSavedArticleSizeBytes * 3);
    const docx = buildZip({
      "_rels/.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.bin"/>' +
        "</Relationships>",
      "word/document.bin": text,
    });

    await expectContentTooLarge(docx, /Decompressed \.docx text/);
  });
});

describe("docx converter queue and worker lifecycle", () => {
  const tiny = (word: string): Buffer => buildMinimalDocx({ paragraphs: [word] });
  // ~3MB of one-character paragraphs: slow to convert, and far past a small heap.
  const dense = buildMinimalDocx({ paragraphs: Array(90_000).fill("x") });

  function converter(overrides: Partial<Parameters<typeof createDocxConverter>[0]> = {}) {
    return createDocxConverter({
      maxHeapMb: 128,
      deadlineMs: 20_000,
      maxQueued: 4,
      resolveFrom: join(process.cwd(), "package.json"),
      ...overrides,
    });
  }

  it("runs one worker at a time and rejects work past the queue depth", async () => {
    const docx = converter({ maxQueued: 1 });
    let maxLive = 0;
    const sampler = setInterval(() => (maxLive = Math.max(maxLive, docx.liveWorkers())), 1);

    const results = await Promise.allSettled(
      ["one", "two", "three"].map((word) => docx.convert(tiny(word)))
    );
    clearInterval(sampler);

    expect(results[0]).toEqual({ status: "fulfilled", value: "<p>one</p>" });
    expect(results[1]).toEqual({ status: "fulfilled", value: "<p>two</p>" });
    expect(results[2].status).toBe("rejected");
    const rejected = results[2] as PromiseRejectedResult;
    expect(getAppErrorCode(rejected.reason)).toBe("SERVER_BUSY");
    expect((rejected.reason as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    expect(maxLive).toBe(1);
    expect(docx.liveWorkers()).toBe(0);
  });

  it("counts the deadline from when a conversion is queued", async () => {
    // A big heap so the dense document runs until the deadline stops it.
    const docx = converter({ maxHeapMb: 2048, deadlineMs: 1000 });
    const started = Date.now();
    const slow = docx.convert(dense).catch((e: unknown) => e);
    const queued = docx
      .convert(tiny("queued"))
      .then(
        () => null,
        (e: unknown) => e
      )
      .then((error) => ({ error, elapsed: Date.now() - started }));

    const [slowError, queuedResult] = await Promise.all([slow, queued]);
    expect(getAppErrorCode(slowError)).toBe("CONTENT_TOO_LARGE");
    expect((slowError as TRPCError).message).toMatch(/too large or complex/);
    // The queued one gave up at its own deadline instead of getting a fresh 1s
    // once the slow one was stopped.
    expect(getAppErrorCode(queuedResult.error)).toBe("CONTENT_TOO_LARGE");
    expect(queuedResult.elapsed).toBeLessThan(1800);
    expect(docx.liveWorkers()).toBe(0);
  }, 30_000);

  it("rejects HTML past the saved-article limit inside the worker", async () => {
    // ~7.6MB of prose: inside the text budget, and a big heap lets it convert,
    // but the ~6.9MB of HTML it renders could never be saved.
    const docx = converter({ maxHeapMb: 1024 });
    const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const error = await docx
      .convert(buildMinimalDocx({ paragraphs: Array(15_000).fill(paragraph) }))
      .catch((e: unknown) => e);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
    expect((error as TRPCError).message).toMatch(/Converted document/);
  }, 30_000);

  it("keeps converting after a worker runs out of memory", async () => {
    const docx = converter({ maxHeapMb: 32 });
    const error = await docx.convert(dense).catch((e: unknown) => e);
    expect((error as TRPCError).message).toMatch(/too large or complex/);

    await expect(docx.convert(tiny("after"))).resolves.toBe("<p>after</p>");
  }, 30_000);

  it("reports a worker that can't load mammoth as a server error, not a bad file", async () => {
    const docx = converter({ resolveFrom: "/nonexistent/package.json" });
    const error = await docx.convert(tiny("x")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");

    // The queue survives it.
    const working = converter();
    await expect(working.convert(tiny("ok"))).resolves.toBe("<p>ok</p>");
  });
});
