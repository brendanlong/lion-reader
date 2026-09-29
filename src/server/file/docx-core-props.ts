/**
 * Reads a `.docx`'s real document properties from `docProps/core.xml`.
 *
 * A `.docx` is a ZIP whose `docProps/core.xml` holds Dublin Core metadata the
 * author actually set (`dc:title`, `dc:creator`, `dc:description`) — far more
 * reliable than guessing title/author/excerpt from the flat run of `<p>` mammoth
 * renders (mammoth doesn't expose these, and Readability tends to promote the
 * first paragraph as a title on chrome-free content). See issue #1404.
 *
 * We read the ZIP with **jszip** — the same library mammoth already loads to
 * parse this exact buffer on every upload — so this adds no new parser or attack
 * surface. `loadAsync` is lazy: it parses the central directory but only inflates
 * an entry when you read it, so we decompress just the tiny `core.xml` (never the
 * large `word/document.xml`). Fully wrapped so a malformed upload just yields
 * empty properties (we fall back to the filename / mammoth body) rather than
 * throwing.
 *
 * Runs in-process with no limits of its own, which is safe only because the
 * upload path calls it after `convertDocxToHtml` (`docx-to-html.ts`) succeeds:
 * that has already bounded the archive's XML parts, `core.xml` included, to the
 * XML inflation budget, and this SAX pass is linear in that. Don't call it on a
 * `.docx` that hasn't been through that check.
 */

import JSZip from "jszip";
import { Parser } from "htmlparser2";
import { logger } from "@/lib/logger";

export interface DocxCoreProperties {
  /** `dc:title` — the author-set document title, if any. */
  title: string | null;
  /** `dc:creator` — the author. */
  author: string | null;
  /** `dc:description` — a short summary/abstract. */
  description: string | null;
}

const EMPTY_PROPERTIES: DocxCoreProperties = { title: null, author: null, description: null };

const CORE_PROPS_PATH = "docProps/core.xml";

/**
 * Extract the core properties (title/author/description) from a `.docx` buffer.
 * Never throws — returns empty properties if the file isn't a readable ZIP, has
 * no `docProps/core.xml`, or anything goes wrong.
 */
export async function extractDocxCoreProperties(buffer: Buffer): Promise<DocxCoreProperties> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file(CORE_PROPS_PATH);
    if (!entry) {
      return EMPTY_PROPERTIES;
    }
    // Only this entry is inflated; document.xml stays compressed.
    const xml = await entry.async("string");
    return parseCoreXml(xml);
  } catch (error) {
    logger.debug("Failed to read docx core properties", {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_PROPERTIES;
  }
}

/**
 * SAX-parse `core.xml`, pulling `dc:title` / `dc:creator` / `dc:description`.
 * xmlMode preserves the `dc:`/`cp:` prefixes; we compare case-insensitively.
 */
function parseCoreXml(xml: string): DocxCoreProperties {
  const result: DocxCoreProperties = { title: null, author: null, description: null };
  let field: keyof DocxCoreProperties | null = null;
  let text = "";

  const parser = new Parser(
    {
      onopentag(name) {
        switch (name.toLowerCase()) {
          case "dc:title":
            field = "title";
            break;
          case "dc:creator":
            field = "author";
            break;
          case "dc:description":
            field = "description";
            break;
          default:
            field = null;
        }
        text = "";
      },
      ontext(chunk) {
        if (field) {
          text += chunk;
        }
      },
      onclosetag() {
        if (field) {
          const value = text.trim();
          // First non-empty value wins (there should only be one of each).
          if (value && !result[field]) {
            result[field] = value;
          }
          field = null;
          text = "";
        }
      },
    },
    { xmlMode: true }
  );

  parser.write(xml);
  parser.end();

  return result;
}
