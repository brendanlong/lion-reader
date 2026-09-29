/**
 * `.docx` → HTML via mammoth, for every path that converts one (file uploads and
 * Google Drive `.docx` saves). Go through {@link convertDocxToHtml} rather than
 * calling mammoth directly: it is where the decompression budget is enforced.
 */

import * as mammoth from "mammoth";
import JSZip from "jszip";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/trpc/errors";

/**
 * A `.docx` may inflate to at most this many times the saved-article size limit
 * (5MB → 50MB by default). mammoth inflates every part it reads whole, with no
 * cap of its own, and deflate reaches ~1000:1, so without this a file inside the
 * upload limit could expand to gigabytes in memory. Real documents sit well
 * under 10x: their XML compresses ~5-10x and embedded images barely compress.
 */
const DOCX_MAX_INFLATION_FACTOR = 10;

const STYLE_MAP = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

/**
 * Throws `CONTENT_TOO_LARGE` if the archive's entries inflate past the budget.
 *
 * Counts the bytes actually inflated rather than trusting the sizes the ZIP
 * declares, which the file's author controls; inflation stops as soon as the
 * running total crosses the budget, so rejecting a bomb costs at most the budget.
 */
async function assertInflatedSizeWithinBudget(buffer: Buffer): Promise<void> {
  const maxBytes = usageLimitsConfig.maxSavedArticleSizeBytes * DOCX_MAX_INFLATION_FACTOR;
  const zip = await JSZip.loadAsync(buffer);

  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    total += await countInflatedBytes(entry, maxBytes - total);
    if (total > maxBytes) {
      throw errors.contentTooLarge("Decompressed .docx content", maxBytes);
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
 * Converts a `.docx` to HTML, mapping Title/Subtitle paragraphs to h1/h2.
 *
 * @throws `CONTENT_TOO_LARGE` if the document inflates past the budget
 */
export async function convertDocxToHtml(buffer: Buffer): Promise<string> {
  await assertInflatedSizeWithinBudget(buffer);

  const result = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP });

  if (result.messages.length > 0) {
    logger.debug("Mammoth conversion messages", {
      messages: result.messages.map((m) => m.message),
    });
  }

  return result.value;
}
