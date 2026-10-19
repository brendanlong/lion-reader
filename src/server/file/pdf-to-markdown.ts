/**
 * `.pdf` → Markdown through the `lion-reader-pdf` helper (`native/pdf`). Go
 * through {@link convertPdfToMarkdown}: it is where the resource bounds are
 * enforced.
 *
 * The helper is a child process, not an N-API module, so the kernel can bound
 * what a hostile PDF costs (`native/pdf/src/main.rs` has the numbers): it caps
 * its own heap and CPU time before reading the file, and we kill it at the
 * deadline. Real documents peak well under the cap (a 100-page arXiv paper at
 * ~60MB, a 244-page book under 1s on one core). Conversions run one at a time
 * per process behind a bounded queue, like `.docx` ones.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/errors";
import { createConversionSlot, QueueTimeoutError } from "@/server/file/conversion-slot";

/** Counted from when the conversion is queued, not from when it starts. */
const CONVERSION_DEADLINE_MS = 20_000;

const MAX_QUEUED_CONVERSIONS = 4;

/**
 * Pages beyond this are rejected before conversion. Layout analysis runs at a
 * few ms per page, so this bounds time rather than memory (5,000 pages took
 * 11s on one core).
 */
const PDF_MAX_PAGES = 1000;

/** Enough of the helper's stderr to log why it failed. */
const MAX_STDERR_BYTES = 4096;

/** Exit status of a Rust process that panicked. */
const RUST_PANIC_EXIT_CODE = 101;

const helperOutputSchema = z.union([
  z.object({
    markdown: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    summary: z.string().nullable(),
  }),
  z.object({
    error: z.enum(["unreadable", "encrypted", "too_many_pages", "output_too_large", "no_text"]),
  }),
]);

export interface ConvertedPdf {
  markdown: string;
  /** Document-info title, else the top heading on the first page. */
  title: string | null;
  author: string | null;
  summary: string | null;
}

interface PdfConverterOptions {
  binaryPath: string;
  maxMemoryMb: number;
  deadlineMs: number;
  maxQueued: number;
  maxPages: number;
}

interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Runs the helper on one file; resolves once the process has exited. */
function runHelper(
  options: PdfConverterOptions,
  buffer: Buffer,
  deadline: number
): Promise<HelperExit> {
  const maxOutputBytes = usageLimitsConfig.maxSavedArticleSizeBytes;
  const child = spawn(
    options.binaryPath,
    [
      String(options.maxMemoryMb * 1024 * 1024),
      String(Math.ceil(options.deadlineMs / 1000)),
      String(options.maxPages),
      String(maxOutputBytes),
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(0, deadline - Date.now())
    );

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });
    // A helper that dies mid-read closes stdin under us; its exit status is
    // what matters, so the write error is ignored.
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: stderr.slice(0, MAX_STDERR_BYTES),
      });
    });
  });
}

function parseHelperOutput(options: PdfConverterOptions, exit: HelperExit): ConvertedPdf {
  const output = helperOutputSchema.parse(JSON.parse(exit.stdout));
  if (!("error" in output)) {
    return output;
  }
  switch (output.error) {
    case "unreadable":
      throw new Error("The file is not a readable PDF");
    case "encrypted":
      throw new Error("The PDF is password-protected");
    case "no_text":
      throw new Error("The PDF has no text to extract (scanned PDFs aren't supported)");
    case "too_many_pages":
      throw new Error(`The PDF has more than ${options.maxPages} pages`);
    case "output_too_large":
      throw errors.contentTooLarge(
        "Converted document",
        usageLimitsConfig.maxSavedArticleSizeBytes
      );
  }
}

/**
 * A converter with its own queue. The app uses the one behind
 * {@link convertPdfToMarkdown}; separate instances exist so tests can shrink
 * the limits.
 */
export function createPdfConverter(options: PdfConverterOptions): {
  convert(buffer: Buffer): Promise<ConvertedPdf>;
} {
  const slot = createConversionSlot(options.maxQueued, "document conversions");

  async function convert(buffer: Buffer): Promise<ConvertedPdf> {
    const deadline = Date.now() + options.deadlineMs;
    let exit: HelperExit;
    try {
      await slot.acquire(deadline);
      try {
        exit = await runHelper(options, buffer, deadline);
      } finally {
        slot.release();
      }
    } catch (error) {
      if (error instanceof QueueTimeoutError) {
        logger.warn("PDF conversion timed out in the queue", { bytes: buffer.length });
        throw errors.serverBusy("document conversions");
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.error("PDF converter binary missing; run `pnpm build:native`", {
          binaryPath: options.binaryPath,
        });
        throw errors.internal("Document conversion failed");
      }
      throw error;
    }

    // Killed at the deadline, or by its own memory (an allocation failure
    // aborts) or CPU cap.
    if (exit.timedOut || exit.signal !== null) {
      logger.warn("PDF conversion exceeded its resource limits", {
        bytes: buffer.length,
        reason: exit.timedOut ? "deadline" : exit.signal,
      });
      throw errors.contentTooComplex("Document");
    }
    if (exit.code === RUST_PANIC_EXIT_CODE) {
      // pdf_oxide gave up on a malformed file rather than returning an error.
      logger.warn("PDF converter panicked", { bytes: buffer.length, stderr: exit.stderr });
      throw new Error("The file is not a readable PDF");
    }
    if (exit.code !== 0) {
      logger.error("PDF converter failed", { code: exit.code, stderr: exit.stderr });
      throw errors.internal("Document conversion failed");
    }
    return parseHelperOutput(options, exit);
  }

  return { convert };
}

const defaultConverter = createPdfConverter({
  binaryPath: join(process.cwd(), "native", "pdf", "lion-reader-pdf"),
  maxMemoryMb: usageLimitsConfig.pdfConverterMaxMemoryMb,
  deadlineMs: CONVERSION_DEADLINE_MS,
  maxQueued: MAX_QUEUED_CONVERSIONS,
  maxPages: PDF_MAX_PAGES,
});

/**
 * Converts a PDF's text to Markdown, with its document-info metadata.
 *
 * @throws `CONTENT_TOO_LARGE` if the result is too large to save, or the
 *   conversion exhausts its memory, CPU or deadline
 * @throws `SERVER_BUSY` if too many conversions are already waiting, or the
 *   deadline passes before this one gets its turn
 * @throws `INTERNAL_ERROR` if the helper is missing or fails unexpectedly
 * @throws a plain `Error` (shown to the user) for a file that isn't a usable
 *   PDF: unreadable, password-protected, scanned, or over the page limit
 */
export function convertPdfToMarkdown(buffer: Buffer): Promise<ConvertedPdf> {
  return defaultConverter.convert(buffer);
}
