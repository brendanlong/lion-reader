import { describe, it, expect } from "vitest";
import { extractDocxCoreProperties } from "@/server/file/docx-core-props";
import { buildZip, buildCoreXml, buildMinimalDocx } from "../utils/docx";

describe("extractDocxCoreProperties", () => {
  it("reads dc:title, dc:creator, and dc:description from docProps/core.xml", async () => {
    const docx = buildMinimalDocx({
      paragraphs: ["Body text."],
      core: {
        title: "Real Document Title",
        creator: "Jane Author",
        description: "A short abstract from the document properties.",
      },
    });

    const props = await extractDocxCoreProperties(docx);
    expect(props.title).toBe("Real Document Title");
    expect(props.author).toBe("Jane Author");
    expect(props.description).toBe("A short abstract from the document properties.");
  });

  it("returns nulls for properties that are absent", async () => {
    const docx = buildMinimalDocx({
      paragraphs: ["Body text."],
      core: { title: "Only A Title" },
    });

    const props = await extractDocxCoreProperties(docx);
    expect(props.title).toBe("Only A Title");
    expect(props.author).toBeNull();
    expect(props.description).toBeNull();
  });

  it("returns all nulls when there is no core.xml at all", async () => {
    const docx = buildMinimalDocx({ paragraphs: ["Body text."] });
    expect(await extractDocxCoreProperties(docx)).toEqual({
      title: null,
      author: null,
      description: null,
    });
  });

  it("decodes XML entities in property values", async () => {
    const zip = buildZip({
      "docProps/core.xml": buildCoreXml({ title: "Tom &amp; Jerry &lt;3" }),
    });
    expect((await extractDocxCoreProperties(zip)).title).toBe("Tom & Jerry <3");
  });

  it("trims surrounding whitespace and ignores empty values", async () => {
    const zip = buildZip({
      "docProps/core.xml": buildCoreXml({ title: "  Padded Title  ", creator: "   " }),
    });
    const props = await extractDocxCoreProperties(zip);
    expect(props.title).toBe("Padded Title");
    expect(props.author).toBeNull();
  });

  it("reads core.xml from an uncompressed (stored) entry", async () => {
    const zip = buildZip(
      { "docProps/core.xml": buildCoreXml({ title: "Stored Entry Title" }) },
      { compression: "store" }
    );
    expect((await extractDocxCoreProperties(zip)).title).toBe("Stored Entry Title");
  });

  it("never throws on a non-zip / garbage buffer (returns empty properties)", async () => {
    expect(await extractDocxCoreProperties(Buffer.from("not a zip at all"))).toEqual({
      title: null,
      author: null,
      description: null,
    });
    expect(await extractDocxCoreProperties(Buffer.alloc(0))).toEqual({
      title: null,
      author: null,
      description: null,
    });
  });
});
