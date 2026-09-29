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
 * CONTENT_TOO_LARGE), one at a time per process, under a timeout, behind two
 * cheap pre-checks that reject the obvious cases without spawning anything.
 *
 * The worker is `eval`'d from a string and resolves mammoth from the working
 * directory's node_modules, so it needs no entry file of its own: that keeps it
 * working unchanged under Next's server build, the esbuild CommonJS bundles
 * (`dist/`), and tsx/vitest. The price is that no bundler sees the dependency —
 * `scripts/fixup-standalone.mjs` copies mammoth into the production image.
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
 * XML parts get 2x: ordinary prose inflates to roughly 0.75 bytes of HTML per
 * byte of `document.xml`, so a document past this renders to more than the
 * saved-article limit and would be rejected after conversion anyway. Media gets
 * the rest of a 10x budget — a real document's images barely compress, so they
 * inflate close to their stored size.
 */
const DOCX_MAX_XML_FACTOR = 2;
const DOCX_MAX_INFLATION_FACTOR = 10;

/**
 * Worker heap cap — the real bound on what converts. Measured: plain prose (a
 * few long runs per paragraph) converts up to the XML budget; Word-style markup
 * (many short runs with rsids per paragraph) converts to ~3MB of `document.xml`,
 * a few hundred pages; dense tiny elements stop near 1MB. A conversion that hits
 * the cap costs ~150MB of RSS before its worker dies.
 */
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 };

const CONVERSION_TIMEOUT_MS = 20_000;

/**
 * mammoth reads and base64-encodes an image once per reference, not once per
 * file, so this counts every read. Images are inlined as data URIs, so bytes
 * beyond the saved-article limit could never be saved anyway.
 */
function imageBudgetBytes(): number {
  return usageLimitsConfig.maxSavedArticleSizeBytes;
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
  .convertToHtml(
    { buffer: Buffer.from(workerData.buffer) },
    { styleMap: workerData.styleMap, convertImage }
  )
  .then(
    (result) =>
      parentPort.postMessage(
        imageBudgetExceeded
          ? { ok: false, imageBudgetExceeded, message: "image budget exceeded" }
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
  | { ok: false; imageBudgetExceeded: boolean; message: string };

function isXmlPart(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xml") || lower.endsWith(".rels");
}

/**
 * Throws `CONTENT_TOO_LARGE` if the archive's entries inflate past the budgets.
 *
 * Counts the bytes actually inflated rather than trusting the sizes the ZIP
 * declares, which the file's author controls; inflation stops as soon as a
 * running total crosses its budget, so rejecting a bomb costs at most the budget.
 */
async function assertInflatedSizeWithinBudget(buffer: Buffer): Promise<void> {
  const maxXml = usageLimitsConfig.maxSavedArticleSizeBytes * DOCX_MAX_XML_FACTOR;
  const maxTotal = usageLimitsConfig.maxSavedArticleSizeBytes * DOCX_MAX_INFLATION_FACTOR;
  const zip = await JSZip.loadAsync(buffer);

  let xml = 0;
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const isXml = isXmlPart(entry.name);
    const remaining = isXml ? Math.min(maxXml - xml, maxTotal - total) : maxTotal - total;
    const bytes = await countInflatedBytes(entry, remaining);
    total += bytes;
    if (isXml) xml += bytes;
    if (xml > maxXml) {
      throw errors.contentTooLarge("Decompressed .docx text", maxXml);
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

/**
 * One conversion at a time per process: each may use the whole worker heap
 * cap, so parallel uploads must queue rather than stack.
 */
let conversionQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = conversionQueue.then(task, task);
  conversionQueue = run.catch(() => {});
  return run;
}

function runWorker(buffer: Buffer): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        buffer,
        styleMap: STYLE_MAP,
        imageBudget: imageBudgetBytes(),
        resolveFrom: join(process.cwd(), "package.json"),
      },
      resourceLimits: WORKER_RESOURCE_LIMITS,
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new DocxConversionTimeoutError()));
    }, CONVERSION_TIMEOUT_MS);

    worker.once("message", (result: WorkerResult) => settle(() => resolve(result)));
    worker.once("error", (error: Error) => settle(() => reject(error)));
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`docx conversion worker exited with code ${code}`)))
    );
  });
}

class DocxConversionTimeoutError extends Error {
  constructor() {
    super(`.docx conversion exceeded ${CONVERSION_TIMEOUT_MS}ms`);
    this.name = "DocxConversionTimeoutError";
  }
}

function isWorkerOutOfMemory(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

/**
 * Converts a `.docx` to HTML, mapping Title/Subtitle paragraphs to h1/h2 and
 * inlining images as data URIs.
 *
 * @throws `CONTENT_TOO_LARGE` if the document is too large to convert, or
 *   exhausts the worker's memory or time limits
 */
export async function convertDocxToHtml(buffer: Buffer): Promise<string> {
  await assertInflatedSizeWithinBudget(buffer);

  let result: WorkerResult;
  try {
    result = await runExclusive(() => runWorker(buffer));
  } catch (error) {
    if (isWorkerOutOfMemory(error) || error instanceof DocxConversionTimeoutError) {
      logger.warn("docx conversion exceeded its resource limits", {
        bytes: buffer.length,
        reason: error instanceof DocxConversionTimeoutError ? "timeout" : "out_of_memory",
      });
      throw errors.contentTooComplex("Document");
    }
    throw error;
  }

  if (!result.ok) {
    if (result.imageBudgetExceeded) {
      throw errors.contentTooLarge("Document images", imageBudgetBytes());
    }
    throw new Error(result.message);
  }

  if (result.messages.length > 0) {
    logger.debug("Mammoth conversion messages", { messages: result.messages });
  }

  return result.html;
}
