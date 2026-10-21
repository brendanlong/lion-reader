/**
 * An in-process S3-compatible server for tests: path-style PUT of an object,
 * ListObjectsV2 and multi-object delete, the calls `src/server/storage/s3.ts`
 * makes. Signatures aren't checked.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { storageConfig } from "@/server/config/env";

export interface FakeS3 {
  /** Stored objects by key. */
  objects: Map<string, { body: Buffer; contentType: string | undefined }>;
  /** Refuse PUTs with a 503. */
  failPuts: boolean;
  /** Report every key of a multi-object delete as failed. */
  failDeletes: boolean;
  /** Points `storageConfig` at this server until {@link close}. */
  close(): Promise<void>;
}

const BUCKET = "test-bucket";

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

export async function startFakeS3(): Promise<FakeS3> {
  const objects: FakeS3["objects"] = new Map();
  const fake = { failPuts: false, failDeletes: false };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (bucket !== BUCKET) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "PUT" && key && fake.failPuts) {
        res.writeHead(503).end();
      } else if (req.method === "PUT" && key) {
        objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers["content-type"] });
        res.writeHead(200).end();
      } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const startAfter = url.searchParams.get("start-after") ?? "";
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > startAfter)
          .sort();
        const page = keys.slice(0, max);
        res
          .writeHead(200, { "Content-Type": "application/xml" })
          .end(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name>` +
              `<IsTruncated>${keys.length > max}</IsTruncated>` +
              page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key></Contents>`).join("") +
              "</ListBucketResult>"
          );
      } else if (req.method === "POST" && url.searchParams.has("delete")) {
        const body = Buffer.concat(chunks).toString("utf8");
        const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => match[1]);
        if (!fake.failDeletes) for (const k of keys) objects.delete(xmlUnescape(k));
        const errors = fake.failDeletes
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const previous = { ...storageConfig };
  Object.assign(storageConfig, {
    bucket: BUCKET,
    accessKeyId: "test",
    secretAccessKey: "test",
    endpoint: `http://127.0.0.1:${port}`,
    region: "auto",
    publicUrlBase: `https://${BUCKET}.storage.test`,
  });

  return Object.assign(fake, {
    objects,
    async close() {
      Object.assign(storageConfig, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
