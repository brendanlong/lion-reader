/**
 * Streaming OPML parser using SAX-style parsing.
 * Parses OPML files from a ReadableStream without loading the entire content into memory.
 */

import { Parser } from "htmlparser2";
import type { OpmlFeed } from "../opml";

/**
 * Error thrown when OPML parsing fails.
 */
export class OpmlStreamParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpmlStreamParseError";
  }
}

/**
 * Parses an OPML file from a ReadableStream.
 *
 * @param stream - The readable stream containing OPML XML data
 * @returns A promise that resolves to an array of OpmlFeed objects
 */
export async function parseOpmlStream(stream: ReadableStream<Uint8Array>): Promise<OpmlFeed[]> {
  const feeds: OpmlFeed[] = [];

  // Track the category path (folder hierarchy)
  const categoryStack: string[] = [];

  // Track if we've seen required elements
  let hasOpml = false;
  let hasBody = false;

  // Track if we're inside body
  let inBody = false;

  // Track outline nesting to handle folder structure
  let outlineDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "opml") {
          hasOpml = true;
        }

        if (tagName === "body") {
          hasBody = true;
          inBody = true;
        }

        if (tagName === "outline" && inBody) {
          outlineDepth++;

          const xmlUrl = attribs.xmlurl || attribs.xmlUrl;
          const text = attribs.text || attribs.title;
          const htmlUrl = attribs.htmlurl || attribs.htmlUrl;
          const type = attribs.type?.toLowerCase();
          const categoryAttr = attribs.category;

          if (xmlUrl) {
            // This is a feed
            const feed: OpmlFeed = {
              xmlUrl,
              title: text,
              htmlUrl: htmlUrl || undefined,
            };

            // Set category from stack or from category attribute
            if (categoryStack.length > 0) {
              feed.category = [...categoryStack];
            } else if (categoryAttr) {
              // Handle comma-separated categories or slash-separated paths
              if (categoryAttr.includes("/")) {
                feed.category = categoryAttr.split("/").map((c: string) => c.trim());
              } else if (categoryAttr.includes(",")) {
                // Take first category if comma-separated
                feed.category = [categoryAttr.split(",")[0].trim()];
              } else {
                feed.category = [categoryAttr.trim()];
              }
            }

            feeds.push(feed);
          } else if (text && !type) {
            // This is a folder (has text but no xmlUrl and no type like "rss")
            categoryStack.push(text);
          }
        }
      },

      onclosetag(name) {
        const tagName = name.toLowerCase();

        if (tagName === "body") {
          inBody = false;
        }

        if (tagName === "outline" && inBody) {
          outlineDepth--;
          // Pop the category if we're leaving a folder
          // We pop if the category stack depth is greater than the outline depth
          while (categoryStack.length > outlineDepth) {
            categoryStack.pop();
          }
        }
      },
    },
    {
      xmlMode: true,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: false, // Preserve attribute case for xmlUrl, htmlUrl
    }
  );

  // Process the stream
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.write(chunk);
    }

    // Flush any remaining data
    parser.end();
  } finally {
    reader.releaseLock();
  }

  // Validate OPML structure
  if (!hasOpml) {
    throw new OpmlStreamParseError("Invalid OPML: missing opml element");
  }

  if (!hasBody) {
    throw new OpmlStreamParseError("Invalid OPML: missing body element");
  }

  return feeds;
}

/**
 * Parses an OPML file from a ReadableStream with a callback for each feed.
 * This version emits feeds as they are parsed, useful for very large OPML files.
 *
 * @param stream - The readable stream containing OPML XML data
 * @param onFeed - Callback called for each parsed feed
 * @returns A promise that resolves when parsing is complete
 */
export async function parseOpmlStreamWithCallback(
  stream: ReadableStream<Uint8Array>,
  onFeed: (feed: OpmlFeed) => void
): Promise<void> {
  // Track the category path (folder hierarchy)
  const categoryStack: string[] = [];

  // Track if we've seen required elements
  let hasOpml = false;
  let hasBody = false;

  // Track if we're inside body
  let inBody = false;

  // Track outline nesting to handle folder structure
  let outlineDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "opml") {
          hasOpml = true;
        }

        if (tagName === "body") {
          hasBody = true;
          inBody = true;
        }

        if (tagName === "outline" && inBody) {
          outlineDepth++;

          const xmlUrl = attribs.xmlurl || attribs.xmlUrl;
          const text = attribs.text || attribs.title;
          const htmlUrl = attribs.htmlurl || attribs.htmlUrl;
          const type = attribs.type?.toLowerCase();
          const categoryAttr = attribs.category;

          if (xmlUrl) {
            // This is a feed
            const feed: OpmlFeed = {
              xmlUrl,
              title: text,
              htmlUrl: htmlUrl || undefined,
            };

            // Set category from stack or from category attribute
            if (categoryStack.length > 0) {
              feed.category = [...categoryStack];
            } else if (categoryAttr) {
              // Handle comma-separated categories or slash-separated paths
              if (categoryAttr.includes("/")) {
                feed.category = categoryAttr.split("/").map((c: string) => c.trim());
              } else if (categoryAttr.includes(",")) {
                // Take first category if comma-separated
                feed.category = [categoryAttr.split(",")[0].trim()];
              } else {
                feed.category = [categoryAttr.trim()];
              }
            }

            // Emit the feed immediately
            onFeed(feed);
          } else if (text && !type) {
            // This is a folder (has text but no xmlUrl and no type like "rss")
            categoryStack.push(text);
          }
        }
      },

      onclosetag(name) {
        const tagName = name.toLowerCase();

        if (tagName === "body") {
          inBody = false;
        }

        if (tagName === "outline" && inBody) {
          outlineDepth--;
          // Pop the category if we're leaving a folder
          while (categoryStack.length > outlineDepth) {
            categoryStack.pop();
          }
        }
      },
    },
    {
      xmlMode: true,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: false,
    }
  );

  // Process the stream
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.write(chunk);
    }

    // Flush any remaining data
    parser.end();
  } finally {
    reader.releaseLock();
  }

  // Validate OPML structure
  if (!hasOpml) {
    throw new OpmlStreamParseError("Invalid OPML: missing opml element");
  }

  if (!hasBody) {
    throw new OpmlStreamParseError("Invalid OPML: missing body element");
  }
}
