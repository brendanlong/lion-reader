/**
 * A small S3-compatible server holding objects in memory, for development and
 * tests: path-style PUT and GET of an object, ListObjectsV2 and multi-object
 * delete, the calls `src/server/storage/s3.ts` makes, with GETs needing no
 * credentials, like the production bucket's. Signatures aren't checked.
 *
 * `pnpm services` runs it for the dev app; tests start it in-process
 * (`tests/utils/fake-s3.ts`). Run it alone with
 * `pnpm exec tsx scripts/fake-s3.ts <port>`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const FAKE_S3_BUCKET = "lion-reader";

export interface FakeS3Server {
  /** The endpoint, `http://127.0.0.1:<port>`. */
  endpoint: string;
  /** Stored objects by key. */
  objects: Map<string, { body: Buffer; contentType: string | undefined }>;
  /** Refuse PUTs with a 503. */
  failPuts: boolean;
  /** Report every key of a multi-object delete as failed. */
  failDeletes: boolean;
  close(): Promise<void>;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function startFakeS3Server(port = 0): Promise<FakeS3Server> {
  const objects: FakeS3Server["objects"] = new Map();
  const state = { failPuts: false, failDeletes: false };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (bucket !== FAKE_S3_BUCKET) {
        res.writeHead(404).end();
      } else if (req.method === "PUT" && key && state.failPuts) {
        res.writeHead(503).end();
      } else if (req.method === "PUT" && key) {
        objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers["content-type"] });
        res.writeHead(200).end();
      } else if (req.method === "GET" && key) {
        const object = objects.get(key);
        if (!object) res.writeHead(404).end();
        else res.writeHead(200, { "Content-Type": object.contentType }).end(object.body);
      } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const startAfter = url.searchParams.get("start-after") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > startAfter)
          .sort();
        const page = keys.slice(0, max);
        res
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${FAKE_S3_BUCKET}</Name>` +
              `<IsTruncated>${keys.length > max}</IsTruncated>` +
              page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key></Contents>`).join("") +
              "</ListBucketResult>"
          );
      } else if (req.method === "POST" && url.searchParams.has("delete")) {
        const body = Buffer.concat(chunks).toString("utf8");
        const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => match[1]);
        if (!state.failDeletes) for (const k of keys) objects.delete(xmlUnescape(k));
        const errors = state.failDeletes
          ? keys.map((k) => `<Error><Key>${k}</Key><Code>InternalError</Code></Error>`).join("")
          : "";
        res
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(`<DeleteResult>${errors}</DeleteResult>`);
      } else {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;

  return Object.assign(state, {
    endpoint: `http://127.0.0.1:${bound}`,
    objects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFakeS3Server(Number(process.argv[2] ?? 0));
  console.log(`Fake S3 serving bucket ${FAKE_S3_BUCKET} at ${server.endpoint}`);
}
