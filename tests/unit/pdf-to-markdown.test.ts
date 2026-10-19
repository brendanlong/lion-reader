/**
 * PDF uploads, through the real `lion-reader-pdf` helper. The layout cleanup
 * is tested in the Rust crate; these cover what the TypeScript side adds: the
 * metadata, the error mapping, and that a hostile file only costs its own
 * process.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { convertUploadedFile } from "@/server/file/process-upload";
import { createPdfConverter } from "@/server/file/pdf-to-markdown";
import { createConversionSlot } from "@/server/file/conversion-slot";
import { getAppErrorCode } from "@/server/errors";
import { buildPdf, textPage } from "../utils/pdf";

const BINARY = join(process.cwd(), "native", "pdf", "lion-reader-pdf");

function converter(overrides: Partial<Parameters<typeof createPdfConverter>[0]> = {}) {
  return createPdfConverter({
    binaryPath: BINARY,
    maxMemoryMb: 128,
    deadlineMs: 20_000,
    slot: createConversionSlot(4, "document conversions"),
    maxPages: 100,
    ...overrides,
  });
}

const prose = textPage(["Lion Reader turns this PDF into an article you can read anywhere."]);

describe("PDF uploads", () => {
  it("takes the title from the first page and drops the heading that repeats it", async () => {
    const page = Buffer.concat([
      textPage(["The Real Title"], 28),
      Buffer.from("\n"),
      textPage(Array(6).fill("Body text that is set much smaller than the title."), 10, 660),
    ]);
    const converted = await convertUploadedFile(buildPdf([page]), "scan0001.pdf");

    expect(converted.preCleanedContent?.title).toBe("The Real Title");
    expect(converted.html).not.toContain("The Real Title");
    expect(converted.html).toContain("Body text");
  });

  it.each([
    ["isn't a PDF", Buffer.from("just some text"), /not a readable PDF/],
    ["has no text layer", buildPdf([Buffer.from("")]), /no text to extract/],
  ])("rejects a file that %s with a message for the user", async (_, file, message) => {
    const error = await convertUploadedFile(file, "file.pdf").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect((error as Error).message).toMatch(message);
  });

  it("rejects a PDF over the page limit before converting it", async () => {
    const pdf = buildPdf([prose, prose, prose]);
    const error = await converter({ maxPages: 2 })
      .convert(pdf)
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/more than 2 pages/);
  });

  it("stops a decompression bomb at the memory cap and keeps converting", async () => {
    // 64MB of drawing operators that deflate to well under 1MB.
    const line = "BT /F1 10 Tf 72 700 Td (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) Tj ET\n";
    const bomb = buildPdf([Buffer.from(line.repeat((64 * 1024 * 1024) / line.length))]);
    const deadlineMs = 20_000;
    const pdf = converter({ maxMemoryMb: 32, deadlineMs });

    const started = Date.now();
    const error = await pdf.convert(bomb).catch((e: unknown) => e);
    // Well before the deadline, so it was the memory cap that stopped it.
    expect(Date.now() - started).toBeLessThan(deadlineMs / 4);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
    expect((error as TRPCError).message).toMatch(/too large or complex/);

    await expect(pdf.convert(buildPdf([prose]))).resolves.toMatchObject({
      markdown: expect.stringContaining("Lion Reader turns this PDF"),
    });
  }, 30_000);

  it("kills a conversion at the deadline", async () => {
    // `sleep` outlasts any deadline without using the CPU, so its own CPU cap
    // can't be what stops it.
    const deadlineMs = 200;
    const started = Date.now();
    const error = await converter({ binaryPath: "/bin/sleep", deadlineMs })
      .convert(buildPdf([prose]))
      .catch((e: unknown) => e);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
    expect(Date.now() - started).toBeLessThan(deadlineMs + 2000);
  });

  it("kills a helper that floods stdout", async () => {
    // `yes` prints its arguments forever.
    const error = await converter({ binaryPath: "/usr/bin/yes" })
      .convert(buildPdf([prose]))
      .catch((e: unknown) => e);
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
  });

  it.each([
    ["is missing", "/nonexistent/lion-reader-pdf"],
    ["isn't executable", join(process.cwd(), "package.json")],
    ["answers outside its protocol", "/bin/cat"],
  ])("reports a helper that %s as a server error, not a bad file", async (_, binaryPath) => {
    const error = await converter({ binaryPath })
      .convert(buildPdf([prose]))
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
  });
});
