/**
 * Streaming OPML parser using SAX-style parsing.
 * Parses OPML files from a ReadableStream, yielding feeds as they're parsed.
 */

import { Parser } from "htmlparser2";
import type { OpmlFeed, StreamingOpmlResult } from "./types";

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
 * Returns immediately; feeds are yielded via async generator as they're parsed.
 */
export async function parseOpmlStream(
  stream: ReadableStream<Uint8Array>
): Promise<StreamingOpmlResult> {
  const categoryStack: string[] = [];
  let hasOpml = false;
  let hasBody = false;
  let inBody = false;
  let outlineDepth = 0;

  const feedQueue: OpmlFeed[] = [];
  let feedResolve: () => void = () => {};
  let parsingComplete = false;
  let parseError: Error | null = null;

  // We need to start parsing before we can validate structure
  let resolveBody!: () => void;
  const bodyPromise = new Promise<void>((resolve) => {
    resolveBody = resolve;
  });

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
          // Only resolve if we've seen <opml> - otherwise wait for validation at end
          if (hasOpml) {
            resolveBody();
          }
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

            feedQueue.push(feed);
            feedResolve();
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
        feedResolve();
        resolveBody();
      },
    },
    {
      xmlMode: true,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: false,
    }
  );

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        parser.write(chunk);
      }
      parser.end();

      // Validate after parsing
      if (!hasOpml) {
        parseError = new OpmlStreamParseError("Invalid OPML: missing opml element");
        resolveBody(); // Unblock the awaiter so it can see the error
      } else if (!hasBody) {
        parseError = new OpmlStreamParseError("Invalid OPML: missing body element");
        resolveBody(); // Unblock the awaiter so it can see the error
      }
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    } finally {
      parsingComplete = true;
      feedResolve();
      reader.releaseLock();
    }
  })();

  // Wait for body to be found (or parsing to complete/fail)
  await bodyPromise;

  if (parseError) throw parseError;

  async function* feedsGenerator(): AsyncGenerator<OpmlFeed, void, undefined> {
    while (true) {
      if (feedQueue.length > 0) {
        yield feedQueue.shift()!;
      } else if (parsingComplete) {
        if (parseError) throw parseError;
        return;
      } else {
        await new Promise<void>((resolve) => {
          feedResolve = resolve;
        });
      }
    }
  }

  return {
    feeds: feedsGenerator(),
  };
}
