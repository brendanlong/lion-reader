/**
 * The shared Redis client must fail fast and reconnect when Redis stops
 * answering. A TCP proxy in front of the real Redis lets the test freeze the
 * connection after the handshake, like a host that vanished mid-connection.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS_COMMAND_TIMEOUT_MS, REDIS_SOCKET_TIMEOUT_MS } from "@/server/redis";

describe("getRedisClient", () => {
  let proxy: Server;
  let sockets: Socket[];
  let connections: number;
  let frozen: boolean;

  beforeEach(async () => {
    const redisUrl = new URL(process.env.REDIS_URL!);
    const upstreamHost = redisUrl.hostname;
    const upstreamPort = Number(redisUrl.port);
    sockets = [];
    connections = 0;
    frozen = false;
    proxy = createServer((client) => {
      connections++;
      const upstream = createConnection(upstreamPort, upstreamHost);
      sockets.push(client, upstream);
      client.on("data", (data) => {
        if (!frozen) upstream.write(data);
      });
      upstream.on("data", (data) => {
        if (!frozen) client.write(data);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;
    redisUrl.hostname = "127.0.0.1";
    redisUrl.port = String(port);
    vi.stubEnv("REDIS_URL", redisUrl.toString());
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it(
    "times out commands and reconnects when Redis stops responding",
    async () => {
      const { getRedisClient } = await import("@/server/redis");
      const redis = getRedisClient()!;
      try {
        await redis.ping();
        frozen = true;

        const start = Date.now();
        await expect(redis.get("key")).rejects.toThrow(/timed out/);
        expect(Date.now() - start).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS * 2);

        frozen = false;
        await vi.waitFor(() => expect(connections).toBe(2), {
          timeout: REDIS_SOCKET_TIMEOUT_MS * 2,
        });
        await expect(redis.ping()).resolves.toBe("PONG");
      } finally {
        redis.disconnect();
      }
    },
    REDIS_SOCKET_TIMEOUT_MS * 3
  );
});
