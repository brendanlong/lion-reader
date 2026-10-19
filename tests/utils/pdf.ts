/**
 * Minimal in-memory PDF builder for tests, so the PDF upload path can be
 * exercised without shipping binary fixtures.
 */

import { deflateSync } from "node:zlib";

interface BuildPdfOptions {
  /** Document information dictionary entries (Title, Author, Subject). */
  info?: Record<string, string>;
}

/**
 * A page's content stream drawing each line of `lines` in Helvetica, the first
 * with its baseline at `top` (points up from the bottom of a 792pt page).
 */
export function textPage(lines: string[], fontSize = 12, top = 720): Buffer {
  const escape = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = lines.map(
    (line, i) => `BT /F1 ${fontSize} Tf 72 ${top - i * fontSize * 1.5} Td (${escape(line)}) Tj ET`
  );
  return Buffer.from(ops.join("\n"), "latin1");
}

/**
 * Builds a PDF with one page per content stream (see {@link textPage}), each
 * stored Flate-compressed.
 */
export function buildPdf(pages: Buffer[], options: BuildPdfOptions = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };

  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add(""); // filled in once the kids exist
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const content of pages) {
    const compressed = deflateSync(content);
    const contentId = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),
        compressed,
        Buffer.from("\nendstream"),
      ])
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
    );
  }
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`
  );
  const info = options.info
    ? add(
        `<< ${Object.entries(options.info)
          .map(([key, value]) => `/${key} (${value})`)
          .join(" ")} >>`
      )
    : null;

  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R`,
    info ? ` /Info ${info} 0 R` : "",
    ` >>\nstartxref\n${offset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}
