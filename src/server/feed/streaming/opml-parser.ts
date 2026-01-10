/**
 * OPML parser using SAX-style parsing.
 * Parses OPML files from a string, returning feeds synchronously.
 */

import { Parser } from "htmlparser2";
import type { OpmlFeed, OpmlParseResult } from "./types";

/**
 * Error thrown when OPML parsing fails.
 */
export class OpmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpmlParseError";
  }
}

/**
 * Parses an OPML file from a string.
 *
 * @param content - The OPML XML content as a string
 * @returns Parsed OPML feeds
 */
export function parseOpml(content: string): OpmlParseResult {
  const categoryStack: string[] = [];
  let hasOpml = false;
  let hasBody = false;
  let inBody = false;
  let outlineDepth = 0;

  const feeds: OpmlFeed[] = [];
  let parseError: Error | null = null;

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
            const feed: OpmlFeed = {
              xmlUrl,
              title: text,
              htmlUrl: htmlUrl || undefined,
            };

            if (categoryStack.length > 0) {
              feed.category = [...categoryStack];
            } else if (categoryAttr) {
              if (categoryAttr.includes("/")) {
                feed.category = categoryAttr.split("/").map((c: string) => c.trim());
              } else if (categoryAttr.includes(",")) {
                feed.category = [categoryAttr.split(",")[0].trim()];
              } else {
                feed.category = [categoryAttr.trim()];
              }
            }

            feeds.push(feed);
          } else if (text && !type) {
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
          while (categoryStack.length > outlineDepth) {
            categoryStack.pop();
          }
        }
      },

      onerror(error) {
        parseError = error;
      },
    },
    {
      xmlMode: true,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: false,
    }
  );

  // Parse the content
  parser.write(content);
  parser.end();

  if (parseError) {
    throw parseError;
  }

  // Validate structure
  if (!hasOpml) {
    throw new OpmlParseError("Invalid OPML: missing opml element");
  }
  if (!hasBody) {
    throw new OpmlParseError("Invalid OPML: missing body element");
  }

  return { feeds };
}
