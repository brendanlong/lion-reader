/**
 * `.pdf` → article HTML through the `lion-reader-pdf` helper (`native/pdf`), for
 * uploads and for URLs that serve a PDF. Go through {@link convertPdfToArticle}:
 * it is where the resource bounds are enforced.
 *
 * The helper is a child process, not an N-API module, so the kernel can bound
 * what a hostile PDF costs (`native/pdf/src/main.rs` has the numbers): it caps
 * its own heap and CPU time before reading the file, and we kill it at the
 * deadline or if it floods stdout. Real documents peak well under the cap (a
 * 100-page arXiv paper at ~60MB, a 244-page book under 1s on one core).
 * Conversions share the `.docx` converter's one-at-a-time slot.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/errors";
import { stripTitleHeader } from "@/server/html/strip-title-header";
import { markdownToHtmlAsync } from "@/server/markdown";
import {
  documentConversionSlot,
  QueueTimeoutError,
  type ConversionSlot,
} from "@/server/file/conversion-slot";

/** Counted from when the conversion is queued, not from when it starts. */
const CONVERSION_DEADLINE_MS = 20_000;

/**
 * Pages beyond this are rejected before conversion. Layout analysis runs at a
 * few ms per page, so this bounds time rather than memory (5,000 pages took
 * 11s on one core).
 */
const PDF_MAX_PAGES = 1000;

/**
 * Room in the helper's stdout beyond twice the Markdown budget, for metadata
 * and JSON framing. The helper strips control characters and caps each
 * metadata string, so JSON escaping at most doubles the text.
 */
const STDOUT_SLACK_BYTES = 64 * 1024;

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

interface ConvertedPdf {
  markdown: string;
  /** Document-info title, else the largest text atop the first page. */
  title: string | null;
  author: string | null;
  summary: string | null;
}

interface PdfConverterOptions {
  binaryPath: string;
  maxMemoryMb: number;
  deadlineMs: number;
  slot: ConversionSlot;
  maxPages: number;
}

interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why we killed it, if we did. */
  killedFor: "deadline" | "output" | null;
  stdout: string;
  stderr: string;
}

/** The helper couldn't run, or answered outside its protocol: our fault, not the file's. */
class HelperFailedError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "HelperFailedError";
  }
}

/** Runs the helper on one file; resolves once the process has exited. */
function runHelper(
  options: PdfConverterOptions,
  buffer: Buffer,
  deadline: number
): Promise<HelperExit> {
  const maxOutputBytes = usageLimitsConfig.maxSavedArticleSizeBytes;
  const maxStdoutBytes = maxOutputBytes * 2 + STDOUT_SLACK_BYTES;
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
    let stdoutBytes = 0;
    let stderr = "";
    let killedFor: HelperExit["killedFor"] = null;
    const kill = (reason: NonNullable<HelperExit["killedFor"]>): void => {
      killedFor ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("deadline"), deadline - Date.now());

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        kill("output");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });
    // A helper that dies mid-read closes stdin under us; its exit status is
    // what matters, so the write error is ignored.
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new HelperFailedError(`couldn't run the PDF converter: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        killedFor,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: stderr.slice(0, MAX_STDERR_BYTES),
      });
    });
  });
}

function parseHelperOutput(options: PdfConverterOptions, exit: HelperExit): ConvertedPdf {
  let output: z.infer<typeof helperOutputSchema>;
  try {
    output = helperOutputSchema.parse(JSON.parse(exit.stdout));
  } catch (error) {
    throw new HelperFailedError(
      `the PDF converter's output didn't parse: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!("error" in output)) {
    return output;
  }
  switch (output.error) {
    case "unreadable":
      throw errors.validation("The file is not a readable PDF");
    case "encrypted":
      throw errors.validation("The PDF is password-protected");
    case "no_text":
      throw errors.validation("The PDF has no text to extract (scanned PDFs aren't supported)");
    case "too_many_pages":
      throw errors.validation(`The PDF has more than ${options.maxPages} pages`);
    case "output_too_large":
      throw errors.contentTooLarge(
        "Converted document",
        usageLimitsConfig.maxSavedArticleSizeBytes
      );
  }
}

/**
 * The app uses the converter behind {@link convertPdfToArticle}; separate
 * instances exist so tests can shrink the limits.
 */
export function createPdfConverter(options: PdfConverterOptions): {
  convert(buffer: Buffer): Promise<ConvertedPdf>;
} {
  const { slot } = options;

  async function run(buffer: Buffer): Promise<ConvertedPdf> {
    const deadline = Date.now() + options.deadlineMs;
    let exit: HelperExit;
    try {
      await slot.acquire(deadline);
      try {
        // Got the slot with no time left: load, not the file.
        if (deadline <= Date.now()) {
          throw new QueueTimeoutError("document conversions");
        }
        exit = await runHelper(options, buffer, deadline);
      } finally {
        slot.release();
      }
    } catch (error) {
      if (error instanceof QueueTimeoutError) {
        logger.warn("PDF conversion timed out in the queue", { bytes: buffer.length });
        throw errors.serverBusy("document conversions");
      }
      throw error;
    }

    // Killed by us at the deadline or for flooding stdout, or by its own
    // memory (an allocation failure aborts) or CPU cap.
    if (exit.killedFor !== null || exit.signal !== null) {
      logger.warn("PDF conversion exceeded its resource limits", {
        bytes: buffer.length,
        reason: exit.killedFor ?? exit.signal,
      });
      throw errors.contentTooComplex("Document");
    }
    if (exit.code === RUST_PANIC_EXIT_CODE) {
      // pdf_oxide gave up on a malformed file rather than returning an error.
      logger.warn("PDF converter panicked", { bytes: buffer.length, stderr: exit.stderr });
      throw errors.validation("The file is not a readable PDF");
    }
    if (exit.code !== 0) {
      throw new HelperFailedError(
        `the PDF converter exited with code ${exit.code}: ${exit.stderr}`
      );
    }
    return parseHelperOutput(options, exit);
  }

  async function convert(buffer: Buffer): Promise<ConvertedPdf> {
    try {
      return await run(buffer);
    } catch (error) {
      if (error instanceof HelperFailedError) {
        logger.error("PDF converter failed", {
          binaryPath: options.binaryPath,
          error: error.message,
        });
        throw errors.internal("Document conversion failed");
      }
      throw error;
    }
  }

  return { convert };
}

const defaultConverter = createPdfConverter({
  binaryPath: join(process.cwd(), "native", "pdf", "lion-reader-pdf"),
  maxMemoryMb: usageLimitsConfig.pdfConverterMaxMemoryMb,
  deadlineMs: CONVERSION_DEADLINE_MS,
  slot: documentConversionSlot,
  maxPages: PDF_MAX_PAGES,
});

/** A PDF as article HTML, with the metadata the helper found. */
export interface PdfArticle {
  html: string;
  /** Document-info title, else the largest text atop the first page. */
  title: string | null;
  author: string | null;
  summary: string | null;
}

/**
 * Converts a PDF to article HTML. The Markdown goes through the usual renderer
 * but not `processMarkdown`: PDF text is never frontmatter, and the title comes
 * from the document, so the first heading is only dropped when it repeats that
 * title.
 *
 * @throws `CONTENT_TOO_LARGE` if the result is too large to save, or the
 *   conversion exhausts its memory, CPU, output or deadline
 * @throws `SERVER_BUSY` if too many conversions are already waiting, or the
 *   deadline passes before this one gets its turn
 * @throws `INTERNAL_ERROR` if the helper can't run or misbehaves
 * @throws `VALIDATION_ERROR` for a file that isn't a usable PDF: unreadable,
 *   password-protected, scanned, or over the page limit
 */
export async function convertPdfToArticle(buffer: Buffer): Promise<PdfArticle> {
  const { markdown, title, author, summary } = await defaultConverter.convert(buffer);
  const html = await markdownToHtmlAsync(markdown);
  return { html: title ? stripTitleHeader(html, title) : html, title, author, summary };
}
