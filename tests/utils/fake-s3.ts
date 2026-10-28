/**
 * Runs `scripts/fake-s3.ts` in-process for a test, pointing `storageConfig`
 * at it.
 */

import { storageConfig } from "../../src/server/config/env";
import { startFakeS3Server, type FakeS3Server } from "../../scripts/fake-s3";

export type FakeS3 = FakeS3Server;

/** Small, so tests cross a page boundary without many objects. */
const LIST_PAGE_SIZE = 2;

/**
 * Starts the fake with a public bucket and, when given, an archive bucket;
 * `close()` stops it and restores the config.
 */
export async function useFakeS3({
  archiveBucket,
  bucket = "test-public",
}: { archiveBucket?: string; bucket?: string } = {}): Promise<FakeS3> {
  const server = await startFakeS3Server({ listPageSize: LIST_PAGE_SIZE });
  const saved = { ...storageConfig };
  Object.assign(storageConfig, {
    bucket,
    archiveBucket,
    accessKeyId: "test",
    secretAccessKey: "test",
    endpoint: server.endpoint,
    region: "auto",
    publicUrlBase: `${server.endpoint}/${bucket}`,
  });

  const close = server.close;
  return Object.assign(server, {
    async close() {
      Object.assign(storageConfig, saved);
      await close();
    },
  });
}
