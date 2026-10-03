import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { describe, it, expect } from "vitest";
import { ZipWriter } from "@/server/file/zip-writer";

async function writeZip(files: Array<[string, string | Uint8Array]>, modified: Date) {
  const zip = new ZipWriter();
  const chunks: Buffer[] = [];
  for (const [name, content] of files) {
    chunks.push(await zip.addFile(name, content, modified));
  }
  chunks.push(zip.finish());
  return Buffer.concat(chunks);
}

describe("ZipWriter", () => {
  it("writes an archive another zip reader can read back", async () => {
    const compressible = "lion ".repeat(10_000);
    const incompressible = randomBytes(4096);
    const modified = new Date("2026-03-14T15:09:26Z");

    const archive = await writeZip(
      [
        ["articles/naïve café.html", compressible],
        ["random.bin", incompressible],
        ["empty.txt", ""],
      ],
      modified
    );
    // Deflate must actually be applied, or every export is uncompressed.
    expect(archive.length).toBeLessThan(compressible.length / 10 + incompressible.length);

    const read = await JSZip.loadAsync(archive);
    expect(Object.keys(read.files).sort()).toEqual([
      "articles/naïve café.html",
      "empty.txt",
      "random.bin",
    ]);
    expect(await read.file("articles/naïve café.html")!.async("string")).toBe(compressible);
    expect(Buffer.from(await read.file("random.bin")!.async("uint8array"))).toEqual(incompressible);
    expect(await read.file("empty.txt")!.async("string")).toBe("");
    // DOS timestamps have two-second resolution.
    expect(read.file("random.bin")!.date.getTime()).toBe(modified.getTime());
  });

  it("switches to Zip64 end records once the file count no longer fits 16 bits", async () => {
    const count = 0xffff + 1;
    const files = Array.from({ length: count }, (_, i): [string, string] => [`${i}`, ""]);

    const read = await JSZip.loadAsync(await writeZip(files, new Date()));

    expect(Object.keys(read.files)).toHaveLength(count);
    expect(read.file(`${count - 1}`)).not.toBeNull();
  }, 60_000);
});
