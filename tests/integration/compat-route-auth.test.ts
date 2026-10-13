/**
 * Every Google Reader and Wallabag route handler rejects a request without
 * credentials (#1935). Unlike tRPC procedures, which are session-only unless
 * they opt in, each compat handler authenticates itself, so a new route that
 * forgets to would be open to anyone. Public routes must be listed below.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const API_DIR = join(import.meta.dirname, "../../src/app/api");
const COMPAT_DIRS = ["greader.php", "wallabag"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Handlers that are public by design: login, discovery and static pages. */
const PUBLIC_HANDLERS = new Set([
  "greader.php GET", // API root health check
  "greader.php/accounts/ClientLogin POST",
  "wallabag GET",
  "wallabag/api/info GET",
  "wallabag/api/info.json GET",
  "wallabag/api/version.json GET",
  "wallabag/developer GET",
  "wallabag/developer/client/create GET",
  "wallabag/developer/client/create POST",
  "wallabag/oauth/v2/token POST",
]);

type Handler = (request: Request, context: { params: Promise<unknown> }) => Promise<Response>;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const handlers = await Promise.all(
  COMPAT_DIRS.flatMap((dir) => routeFiles(join(API_DIR, dir))).map(async (file) => {
    const route = relative(API_DIR, file).replace(/\/route\.ts$/, "");
    const mod = (await import(file)) as Partial<Record<(typeof METHODS)[number], Handler>>;
    return METHODS.flatMap((method) => {
      const handler = mod[method];
      return handler ? [{ name: `${route} ${method}`, method, handler }] : [];
    });
  })
).then((lists) => lists.flat());

describe("compat route authentication", () => {
  it("finds the compat routes", () => {
    expect(handlers.length).toBeGreaterThan(PUBLIC_HANDLERS.size);
    const names = new Set(handlers.map((h) => h.name));
    expect([...PUBLIC_HANDLERS].filter((name) => !names.has(name))).toEqual([]);
  });

  it.each(handlers.filter((h) => !PUBLIC_HANDLERS.has(h.name)))(
    "$name rejects a request without credentials",
    async ({ method, handler }) => {
      const request = new Request("https://example.com/api/compat", {
        method,
        ...(method === "GET" ? {} : { body: "" }),
      });

      const res = await handler(request, {
        params: Promise.resolve({ entry: "1", tag: "1", streamId: [] }),
      });

      expect(res.status).toBe(401);
    }
  );
});
