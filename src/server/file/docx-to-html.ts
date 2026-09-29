/**
 * `.docx` → HTML via mammoth, for every path that converts one (file uploads and
 * Google Drive `.docx` saves). Go through {@link convertDocxToHtml} rather than
 * calling mammoth directly: it is where the memory bounds are enforced.
 *
 * mammoth builds a full DOM of `document.xml` — ~40MB of heap per MB of plain
 * prose, ~250MB per MB of dense tiny elements — and inlines every image
 * *reference* as its own base64 copy. A few-KB upload can therefore cost
 * gigabytes, while our VMs have 512MB. So the conversion runs in a worker thread
 * with a V8 heap cap (an OOM kills only the worker and surfaces as
 * CONTENT_TOO_LARGE), one at a time per process behind a bounded queue, under a
 * deadline, behind two cheap pre-checks that reject the obvious cases without
 * spawning anything.
 *
 * The worker is `eval`'d from a string and resolves mammoth from the working
 * directory's node_modules, so it needs no entry file of its own: that keeps it
 * working unchanged under Next's server build, the esbuild CommonJS bundles
 * (`dist/`), and tsx/vitest. The price is that no bundler sees the dependency —
 * `scripts/fixup-standalone.mjs` copies mammoth into the production image and
 * fails the build if it can't convert a document from there.
 */

import { Worker } from "node:worker_threads";
import { join } from "node:path";
import JSZip from "jszip";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/trpc/errors";

/**
 * Inflated-size budgets, as multiples of the saved-article size limit (5MB by
 * default).
 *
 * Everything outside `word/media/` gets 2x. mammoth finds the main document
 * through the package relationships, not by name or extension, so any part may
 * be the one it parses; and ordinary prose inflates to roughly 0.75 bytes of
 * HTML per byte of `document.xml`, so a document past this renders to more than
 * the saved-article limit and would be rejected after conversion anyway. Media
 * gets the rest of a 10x budget — a real document's images barely compress, so
 * they inflate close to their stored size.
 */
const DOCX_MAX_TEXT_FACTOR = 2;
const DOCX_MAX_INFLATION_FACTOR = 10;
const MEDIA_PREFIX = "word/media/";

/**
 * The worker's heap cap (`usageLimitsConfig.docxWorkerMaxHeapMb`, 64MB by
 * default; young generation scales with it) is the real bound on what
 * converts. Measured at 64MB on the production build: plain prose (a few long
 * runs per paragraph) converts to ~3.5MB of `document.xml`, ~2.5MB of HTML;
 * Word-style markup (many short runs with rsids per paragraph) to ~1.25MB,
 * ~45k words; dense tiny elements not even at 1MB. A worker running out of
 * memory peaked ~60MB above idle. (The Discord bot runs at 48MB: ~2MB of prose,
 * ~18k words of Word-style markup.)
 */
function youngGenerationMb(maxHeapMb: number): number {
  return Math.max(2, Math.round(maxHeapMb / 8));
}

/** Counted from when the conversion is queued, not from when it starts. */
const CONVERSION_DEADLINE_MS = 20_000;

/**
 * Conversions allowed to wait behind the running one. Each waiter holds its
 * upload (up to the saved-article limit) in memory, and one past this would
 * likely miss its deadline anyway.
 */
const MAX_QUEUED_CONVERSIONS = 4;

/**
 * mammoth reads and base64-encodes an image once per reference, not once per
 * file, so this counts every read. Images are inlined as base64 data URIs, so
 * past 3/4 of the saved-article limit they could never be saved anyway.
 */
function imageBudgetBytes(): number {
  return Math.floor((usageLimitsConfig.maxSavedArticleSizeBytes * 3) / 4);
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const mammoth = createRequire(workerData.resolveFrom)("mammoth");

// mammoth turns a convertImage error into a warning and carries on, so the
// overrun is remembered here and reported once conversion finishes.
let imageBytes = 0;
let imageBudgetExceeded = false;
const convertImage = mammoth.images.imgElement(async (image) => {
  if (!imageBudgetExceeded) {
    const data = await image.readAsBuffer();
    imageBytes += data.length;
    if (imageBytes <= workerData.imageBudget) {
      return { src: "data:" + image.contentType + ";base64," + data.toString("base64") };
    }
    imageBudgetExceeded = true;
  }
  throw new Error("image budget exceeded");
});

mammoth
  .convertToHtml({ buffer: workerData.buffer }, { styleMap: workerData.styleMap, convertImage })
  .then(
    (result) =>
      parentPort.postMessage(
        imageBudgetExceeded
          ? { ok: false, imageBudgetExceeded, message: "image budget exceeded" }
          : result.value.length > workerData.maxHtmlLength
            ? { ok: false, htmlTooLarge: true, message: "html too large" }
            : { ok: true, html: result.value, messages: result.messages.map((m) => m.message) }
      ),
    (error) =>
      parentPort.postMessage({
        ok: false,
        imageBudgetExceeded,
        message: error instanceof Error ? error.message : String(error),
      })
  );
`;

const STYLE_MAP = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

type WorkerResult =
  | { ok: true; html: string; messages: string[] }
  | { ok: false; imageBudgetExceeded?: boolean; htmlTooLarge?: boolean; message: string };

/**
 * Throws `CONTENT_TOO_LARGE` if the archive's entries inflate past the budgets.
 *
 * Counts the bytes actually inflated rather than trusting the sizes the ZIP
 * declares, which the file's author controls; inflation stops as soon as a
 * running total crosses its budget, so rejecting a bomb costs at most the budget.
 */
async function assertInflatedSizeWithinBudget(buffer: Buffer): Promise<void> {
  const maxText = usageLimitsConfig.maxSavedArticleSizeBytes * DOCX_MAX_TEXT_FACTOR;
  const maxTotal = usageLimitsConfig.maxSavedArticleSizeBytes * DOCX_MAX_INFLATION_FACTOR;
  const zip = await JSZip.loadAsync(buffer);

  let text = 0;
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const isText = !entry.name.startsWith(MEDIA_PREFIX);
    const remaining = isText ? Math.min(maxText - text, maxTotal - total) : maxTotal - total;
    const bytes = await countInflatedBytes(entry, remaining);
    total += bytes;
    if (isText) text += bytes;
    if (text > maxText) {
      throw errors.contentTooLarge("Decompressed .docx text", maxText);
    }
    if (total > maxTotal) {
      throw errors.contentTooLarge("Decompressed .docx content", maxTotal);
    }
  }
}

/**
 * Inflates one entry, returning its size — or, once it passes `budget`, a count
 * just over it, having paused the stream so no more is inflated.
 */
function countInflatedBytes(entry: JSZip.JSZipObject, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream();
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > budget) {
        stream.pause();
        resolve(bytes);
      }
    });
    stream.on("end", () => resolve(bytes));
    stream.on("error", reject);
  });
}

class DeadlineExceededError extends Error {
  constructor() {
    super(".docx conversion missed its deadline");
    this.name = "DeadlineExceededError";
  }
}

/** The worker crashed or couldn't start: our bug, not the user's file. */
class WorkerFailedError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "WorkerFailedError";
  }
}

function isWorkerOutOfMemory(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

interface DocxConverterOptions {
  maxHeapMb: number;
  deadlineMs: number;
  maxQueued: number;
  /** Path mammoth is resolved from (any file in the directory that holds node_modules). */
  resolveFrom: string;
}

interface DocxConverter {
  convert(buffer: Buffer): Promise<string>;
  /** Worker threads currently alive — never more than one. */
  liveWorkers(): number;
}

/**
 * A converter with its own queue. The app uses the one behind
 * {@link convertDocxToHtml}; separate instances exist so tests can shrink the
 * limits.
 */
export function createDocxConverter(options: DocxConverterOptions): DocxConverter {
  let busy = false;
  let live = 0;
  const waiting: Array<() => void> = [];

  /** Waits for the single slot, giving up at the deadline. */
  function acquire(deadline: number): Promise<void> {
    if (!busy) {
      busy = true;
      return Promise.resolve();
    }
    if (waiting.length >= options.maxQueued) {
      return Promise.reject(errors.serverBusy("document conversions"));
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(grant), 1);
        reject(new DeadlineExceededError());
      }, deadline - Date.now());
      waiting.push(grant);
    });
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      busy = false;
    }
  }

  /** Runs one worker to completion; resolves only once its thread has exited. */
  async function runWorker(buffer: Buffer, deadline: number): Promise<WorkerResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DeadlineExceededError();
    }

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        buffer,
        styleMap: STYLE_MAP,
        imageBudget: imageBudgetBytes(),
        // Checked in the worker so an unsaveable result is never copied back.
        maxHtmlLength: usageLimitsConfig.maxSavedArticleSizeBytes,
        resolveFrom: options.resolveFrom,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: options.maxHeapMb,
        maxYoungGenerationSizeMb: youngGenerationMb(options.maxHeapMb),
      },
    });
    live++;
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    void exited.then(() => live--);

    const outcome = new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeadlineExceededError()), remaining);
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      worker.once("message", (result: WorkerResult) => done(() => resolve(result)));
      worker.once("error", (error: Error) =>
        done(() =>
          reject(
            isWorkerOutOfMemory(error)
              ? error
              : new WorkerFailedError(`docx worker failed: ${error.message}`, { cause: error })
          )
        )
      );
      worker.once("exit", (code) =>
        done(() => reject(new WorkerFailedError(`docx worker exited with code ${code}`)))
      );
    });

    try {
      return await outcome;
    } finally {
      await worker.terminate();
      await exited;
    }
  }

  async function convert(buffer: Buffer): Promise<string> {
    await assertInflatedSizeWithinBudget(buffer);

    const deadline = Date.now() + options.deadlineMs;
    let result: WorkerResult;
    try {
      await acquire(deadline);
      try {
        result = await runWorker(buffer, deadline);
      } finally {
        release();
      }
    } catch (error) {
      if (isWorkerOutOfMemory(error) || error instanceof DeadlineExceededError) {
        logger.warn("docx conversion exceeded its resource limits", {
          bytes: buffer.length,
          reason: error instanceof DeadlineExceededError ? "deadline" : "out_of_memory",
        });
        throw errors.contentTooComplex("Document");
      }
      if (error instanceof WorkerFailedError) {
        logger.error("docx conversion worker failed", { error: error.message });
        throw errors.internal("Document conversion failed");
      }
      throw error;
    }

    if (!result.ok) {
      if (result.imageBudgetExceeded) {
        throw errors.contentTooLarge("Document images", imageBudgetBytes());
      }
      if (result.htmlTooLarge) {
        throw errors.contentTooLarge(
          "Converted document",
          usageLimitsConfig.maxSavedArticleSizeBytes
        );
      }
      // mammoth rejected the document itself: a malformed or non-Word file.
      throw new Error(result.message);
    }

    if (result.messages.length > 0) {
      logger.debug("Mammoth conversion messages", { messages: result.messages });
    }

    return result.html;
  }

  return { convert, liveWorkers: () => live };
}

const defaultConverter = createDocxConverter({
  maxHeapMb: usageLimitsConfig.docxWorkerMaxHeapMb,
  deadlineMs: CONVERSION_DEADLINE_MS,
  maxQueued: MAX_QUEUED_CONVERSIONS,
  resolveFrom: join(process.cwd(), "package.json"),
});

/**
 * Converts a `.docx` to HTML, mapping Title/Subtitle paragraphs to h1/h2 and
 * inlining images as data URIs.
 *
 * @throws `CONTENT_TOO_LARGE` if the document is too large to convert, or
 *   exhausts the worker's memory or the deadline
 * @throws `SERVER_BUSY` if too many conversions are already waiting
 * @throws `INTERNAL_ERROR` if the worker itself fails
 * @throws a plain `Error` if mammoth rejects the file
 */
export function convertDocxToHtml(buffer: Buffer): Promise<string> {
  return defaultConverter.convert(buffer);
}
