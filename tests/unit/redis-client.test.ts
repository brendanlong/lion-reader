import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getRedisClient", () => {
  let server: Server;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    // Accepts connections but never replies, like a Redis host that went away
    // without closing the TCP connection.
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${port}`);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects commands within the command timeout when Redis stops responding", async () => {
    const { getRedisClient, REDIS_COMMAND_TIMEOUT_MS } = await import("@/server/redis");
    const redis = getRedisClient()!;
    try {
      const start = Date.now();
      await expect(redis.get("key")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS * 2);
    } finally {
      redis.disconnect();
    }
  });
});
