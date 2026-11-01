/** Cache Storage (`caches`), which jsdom doesn't have, kept in memory. */

class MemoryCache {
  readonly files = new Map<string, Uint8Array>();

  async keys(): Promise<Request[]> {
    return [...this.files.keys()].map((url) => new Request(url));
  }

  async match(url: string): Promise<Response | undefined> {
    const bytes = this.files.get(url);
    return bytes ? new Response(bytes.slice()) : undefined;
  }

  async put(url: string, response: Response): Promise<void> {
    this.files.set(url, new Uint8Array(await response.arrayBuffer()));
  }

  async delete(request: Request | string): Promise<boolean> {
    return this.files.delete(typeof request === "string" ? request : request.url);
  }
}

export interface MemoryCacheStorage {
  open(name: string): Promise<MemoryCache>;
  delete(name: string): Promise<boolean>;
  /** Every URL stored, across caches. */
  storedUrls(): string[];
}

export function createMemoryCacheStorage(): MemoryCacheStorage {
  const caches = new Map<string, MemoryCache>();
  return {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new MemoryCache());
      return caches.get(name)!;
    },
    async delete(name) {
      return caches.delete(name);
    },
    storedUrls() {
      return [...caches.values()].flatMap((cache) => [...cache.files.keys()]);
    },
  };
}
