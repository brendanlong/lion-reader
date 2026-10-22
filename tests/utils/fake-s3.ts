/**
 * A loopback stand-in for the S3 API calls `src/server/storage/s3.ts` makes
 * (path-style PUT, DELETE and ListObjectsV2), pointed at by `useFakeS3`.
 * Signatures aren't checked.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { storageConfig } from "../../src/server/config/env";

/** Small, so tests cross a page boundary without many objects. */
const LIST_PAGE_SIZE = 2;

export interface FakeS3 {
  /** Stored objects by `bucket/key`. */
  objects: Map<string, Buffer>;
  /** When set, every PUT answers with this status. */
  failPutsWith: number | null;
  close(): Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Starts the fake and points `storageConfig` at it with `archiveBucket` set;
 * `close()` stops it and restores the config.
 */
export async function useFakeS3(archiveBucket = "test-archive"): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const fake: FakeS3 = { objects, failPutsWith: null, close: async () => {} };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, bucket, ...keyParts] = url.pathname.split("/");
    const key = decodeURIComponent(keyParts.join("/"));

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (fake.failPutsWith !== null) {
          res.writeHead(fake.failPutsWith);
          res.end();
          return;
        }
        objects.set(`${bucket}/${key}`, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(`${bucket}/${key}`);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const after = url.searchParams.get("continuation-token") ?? "";
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/`))
        .map((k) => k.slice(bucket.length + 1))
        .filter((k) => k.startsWith(prefix) && k > after)
        .sort();
      const page = keys.slice(0, LIST_PAGE_SIZE);
      const truncated = keys.length > page.length;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          page.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`).join("") +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated
            ? `<NextContinuationToken>${escapeXml(page[page.length - 1])}</NextContinuationToken>`
            : "") +
          `</ListBucketResult>`
      );
      return;
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const saved = { ...storageConfig };
  Object.assign(storageConfig, {
    archiveBucket,
    accessKeyId: "test",
    secretAccessKey: "test",
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    region: "auto",
  });

  fake.close = async () => {
    Object.assign(storageConfig, saved);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
