/**
 * A loopback stand-in for the S3 API calls `src/server/storage/s3.ts` makes
 * (path-style PUT, GET, DELETE and ListObjectsV2), holding objects in memory.
 * GETs need no credentials, as from the public bucket; signatures aren't
 * checked. Tests start it through `useFakeS3` (`tests/utils/fake-s3.ts`), and
 * `pnpm services` runs it for the dev app: `pnpm exec tsx scripts/fake-s3.ts <port>`.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export interface FakeS3Server {
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** Stored objects by `bucket/key`. */
  objects: Map<string, { body: Buffer; contentType: string | undefined }>;
  /** When set, every PUT answers with this status. */
  failPutsWith: number | null;
  /** When set, every DELETE answers with this status. */
  failDeletesWith: number | null;
  close(): Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param listPageSize - Keys per ListObjectsV2 page; tests make it small to
 *   cross a page boundary without many objects.
 */
export async function startFakeS3Server({
  port = 0,
  listPageSize = 1000,
}: { port?: number; listPageSize?: number } = {}): Promise<FakeS3Server> {
  const objects: FakeS3Server["objects"] = new Map();
  const state = { failPutsWith: null as number | null, failDeletesWith: null as number | null };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, bucket, ...keyParts] = url.pathname.split("/");
    const key = decodeURIComponent(keyParts.join("/"));

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (state.failPutsWith !== null) {
          res.writeHead(state.failPutsWith).end();
          return;
        }
        objects.set(`${bucket}/${key}`, {
          body: Buffer.concat(chunks),
          contentType: req.headers["content-type"],
        });
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === "DELETE") {
      if (state.failDeletesWith !== null) {
        res.writeHead(state.failDeletesWith).end();
        return;
      }
      objects.delete(`${bucket}/${key}`);
      res.writeHead(204).end();
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
      const page = keys.slice(0, listPageSize);
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
    if (req.method === "GET" && key) {
      const object = objects.get(`${bucket}/${key}`);
      if (!object) res.writeHead(404).end();
      else res.writeHead(200, { "Content-Type": object.contentType }).end(object.body);
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return Object.assign(state, {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFakeS3Server({ port: Number(process.argv[2] ?? 0) });
  console.log(`Fake S3 at ${server.endpoint}`);
}
