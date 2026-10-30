/** Opens an uploaded ZIP archive (EPUB, DOCX) with JSZip. */

import JSZip from "jszip";
import { errors } from "@/server/errors";

export type ZipArchive = JSZip;
export type ZipArchiveEntry = JSZip.JSZipObject;

/**
 * The most entries an archive may have. JSZip builds objects for every
 * central-directory entry on the main thread before anything can budget the
 * archive: 250k empty entries in a 21MB file took ~700MB.
 */
export const MAX_ZIP_ENTRIES = 10_000;

const CENTRAL_FILE_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/**
 * How many central-directory header signatures `buffer` holds, counting no
 * further than `limit + 1`. JSZip reads every header it finds whatever count
 * the end record declares, so this, not the declared count, bounds its work.
 */
function countCentralHeaders(buffer: Buffer, limit: number): number {
  let count = 0;
  let index = buffer.indexOf(CENTRAL_FILE_HEADER_SIGNATURE);
  while (index !== -1 && count <= limit) {
    count++;
    index = buffer.indexOf(CENTRAL_FILE_HEADER_SIGNATURE, index + 1);
  }
  return count;
}

/**
 * Loads `buffer` with JSZip, after rejecting an archive of more than
 * {@link MAX_ZIP_ENTRIES} entries.
 *
 * @throws `CONTENT_TOO_LARGE` if the archive has too many entries
 * @throws JSZip's error if `buffer` isn't a ZIP archive
 */
export async function loadZip(buffer: Buffer): Promise<ZipArchive> {
  if (countCentralHeaders(buffer, MAX_ZIP_ENTRIES) > MAX_ZIP_ENTRIES) {
    throw errors.contentTooComplex("The archive");
  }
  return JSZip.loadAsync(buffer);
}
