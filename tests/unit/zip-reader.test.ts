import { describe, it, expect } from "vitest";
import { openEpub } from "@/server/file/epub";
import { loadZip, MAX_ZIP_ENTRIES } from "@/server/file/zip-reader";
import { getAppErrorCode } from "@/server/errors";
import { buildZip } from "../utils/docx";

function zipOfEmptyEntries(count: number): Buffer {
  return buildZip(Object.fromEntries(Array.from({ length: count }, (_, i) => [`${i}.txt`, ""])));
}

/** `zip` with its end record declaring a single entry, whatever it holds. */
function declaringOneEntry(zip: Buffer): Buffer {
  const lying = Buffer.from(zip);
  const endRecord = lying.length - 22;
  lying.writeUInt16LE(1, endRecord + 8);
  lying.writeUInt16LE(1, endRecord + 10);
  return lying;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe("loadZip", () => {
  const atLimit = zipOfEmptyEntries(MAX_ZIP_ENTRIES);
  const pastLimit = zipOfEmptyEntries(MAX_ZIP_ENTRIES + 1);

  it("loads an archive of the most entries allowed", async () => {
    const zip = await loadZip(atLimit);
    expect(Object.keys(zip.files)).toHaveLength(MAX_ZIP_ENTRIES);
  });

  it("rejects an archive of more entries, whatever count it declares", async () => {
    for (const zip of [pastLimit, declaringOneEntry(pastLimit)]) {
      expect(getAppErrorCode(await rejection(loadZip(zip)))).toBe("CONTENT_TOO_LARGE");
    }
  });

  it("surfaces the rejection from an ebook import", async () => {
    expect(getAppErrorCode(await rejection(openEpub(pastLimit)))).toBe("CONTENT_TOO_LARGE");
  });
});
