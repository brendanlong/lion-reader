/**
 * In-process cache for the AI providers' catalogs (models, voices). Callers
 * asking together share one fetch, and a refresh that fails serves what was
 * fetched last, retried a while later rather than on every call: a provider's
 * outage shouldn't take the voices it already listed away.
 */

interface Entry<V> {
  expiresAt: number;
  /** Absent until the first fetch succeeds. */
  value?: V;
  /** A first fetch's failure, kept until `expiresAt`. */
  failure?: unknown;
  refresh?: Promise<V>;
}

export interface CatalogCacheOptions {
  ttlMs: number;
  /** How long a failed refresh waits before the next, serving the stale value meanwhile. */
  retryMs: number;
  /**
   * How long a first fetch's failure is kept (0: not kept), so an outage
   * doesn't cost every request a timeout.
   */
  failureTtlMs?: number;
  /** Keys kept, least recently fetched dropped first. */
  maxEntries?: number;
  now?: () => number;
}

export class CatalogCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly now: () => number;

  constructor(
    private readonly fetch: (key: string) => Promise<V>,
    private readonly options: CatalogCacheOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): Promise<V> {
    const entry = this.entries.get(key);
    if (entry && this.now() < entry.expiresAt) {
      return "value" in entry ? Promise.resolve(entry.value as V) : Promise.reject(entry.failure);
    }
    if (entry?.refresh) return entry.refresh;
    const current: Entry<V> = entry ?? { expiresAt: 0 };
    const refresh = this.refresh(key, current);
    current.refresh = refresh;
    // Re-inserted, so the map stays in fetch order for eviction.
    this.entries.delete(key);
    this.entries.set(key, current);
    this.evict();
    return refresh;
  }

  private async refresh(key: string, entry: Entry<V>): Promise<V> {
    try {
      const value = await this.fetch(key);
      entry.value = value;
      entry.failure = undefined;
      entry.expiresAt = this.now() + this.options.ttlMs;
      return value;
    } catch (error) {
      if ("value" in entry) {
        entry.expiresAt = this.now() + this.options.retryMs;
        return entry.value as V;
      }
      const keepFor = this.options.failureTtlMs ?? 0;
      if (keepFor > 0) {
        entry.failure = error;
        entry.expiresAt = this.now() + keepFor;
      } else if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      throw error;
    } finally {
      entry.refresh = undefined;
    }
  }

  private evict(): void {
    const max = this.options.maxEntries ?? Infinity;
    for (const key of this.entries.keys()) {
      if (this.entries.size <= max) break;
      this.entries.delete(key);
    }
  }
}
