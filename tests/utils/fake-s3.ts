/**
 * Runs `scripts/fake-s3.ts` in-process and points `storageConfig` at it.
 */

import { storageConfig } from "@/server/config/env";
import { FAKE_S3_BUCKET, startFakeS3Server, type FakeS3Server } from "../../scripts/fake-s3";

export type FakeS3 = FakeS3Server;

/** Starts the server; `close` also restores `storageConfig`. */
export async function startFakeS3(): Promise<FakeS3> {
  const server = await startFakeS3Server();
  const previous = { ...storageConfig };
  Object.assign(storageConfig, {
    bucket: FAKE_S3_BUCKET,
    accessKeyId: "test",
    secretAccessKey: "test",
    endpoint: server.endpoint,
    region: "auto",
    publicUrlBase: `${server.endpoint}/${FAKE_S3_BUCKET}`,
  });
  const close = server.close;
  return Object.assign(server, {
    async close() {
      Object.assign(storageConfig, previous);
      await close();
    },
  });
}
