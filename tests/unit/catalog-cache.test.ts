import { describe, it, expect } from "vitest";
import { CatalogCache } from "@/server/services/catalog-cache";

function setup(options: { failureTtlMs?: number; maxEntries?: number } = {}) {
  let now = 0;
  const fetches: string[] = [];
  let fail = false;
  const cache = new CatalogCache(
    async (key) => {
      fetches.push(key);
      if (fail) throw new Error(`no ${key}`);
      return `${key}@${now}`;
    },
    { ttlMs: 100, retryMs: 10, now: () => now, ...options }
  );
  return {
    cache,
    fetches,
    advance: (ms: number) => (now += ms),
    failing: (value: boolean) => (fail = value),
  };
}

describe("CatalogCache", () => {
  it("fetches once for callers asking together, and again once stale", async () => {
    const { cache, fetches, advance } = setup();
    expect(await Promise.all([cache.get("a"), cache.get("a")])).toEqual(["a@0", "a@0"]);
    advance(99);
    expect(await cache.get("a")).toBe("a@0");
    advance(1);
    expect(await cache.get("a")).toBe("a@100");
    expect(fetches).toEqual(["a", "a"]);
  });

  it("serves the stale value when a refresh fails, and retries a while later", async () => {
    const { cache, fetches, advance, failing } = setup();
    await cache.get("a");
    advance(100);
    failing(true);
    expect(await cache.get("a")).toBe("a@0");
    advance(5);
    expect(await cache.get("a")).toBe("a@0");
    expect(fetches).toHaveLength(2);
    advance(5);
    failing(false);
    expect(await cache.get("a")).toBe("a@110");
  });

  it("passes on a first fetch's failure, kept only as long as asked", async () => {
    const plain = setup();
    plain.failing(true);
    await expect(plain.cache.get("a")).rejects.toThrow("no a");
    await expect(plain.cache.get("a")).rejects.toThrow("no a");
    expect(plain.fetches).toHaveLength(2);

    const kept = setup({ failureTtlMs: 30 });
    kept.failing(true);
    await expect(kept.cache.get("a")).rejects.toThrow("no a");
    kept.failing(false);
    await expect(kept.cache.get("a")).rejects.toThrow("no a");
    kept.advance(30);
    expect(await kept.cache.get("a")).toBe("a@30");
  });

  it("keeps the most recently fetched keys", async () => {
    const { cache, fetches } = setup({ maxEntries: 2 });
    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    await cache.get("b");
    await cache.get("a");
    expect(fetches).toEqual(["a", "b", "c", "a"]);
  });
});
