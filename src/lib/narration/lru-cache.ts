/**
 * LRU Cache Implementation
 *
 * A simple Least Recently Used (LRU) cache that evicts the oldest items
 * when the maximum size is reached. Used for caching audio buffers to
 * prevent unbounded memory growth during long narration sessions.
 *
 * @module narration/lru-cache
 */

/**
 * A Least Recently Used (LRU) cache with a maximum size limit.
 *
 * When the cache reaches its maximum size, the least recently accessed
 * item is evicted to make room for new entries. Both `get` and `set`
 * operations update the recency of an item.
 *
 * @typeParam K - The type of cache keys
 * @typeParam V - The type of cache values
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  /**
   * Creates a new LRU cache.
   *
   * @param maxSize - Maximum number of items to store (must be at least 1)
   */
  constructor(maxSize: number) {
    if (maxSize < 1) {
      throw new Error("LRU cache maxSize must be at least 1");
    }
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * Gets a value from the cache, updating its recency.
   *
   * @param key - The key to look up
   * @returns The cached value, or undefined if not found
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by deleting and re-adding
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Sets a value in the cache, evicting the LRU item if at capacity.
   *
   * @param key - The key to store
   * @param value - The value to store
   */
  set(key: K, value: V): void {
    // If key exists, delete it first (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, value);
  }

  /**
   * Checks if a key exists in the cache (does not update recency).
   *
   * @param key - The key to check
   * @returns True if the key exists in the cache
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Removes all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Gets the current number of items in the cache.
   */
  get size(): number {
    return this.cache.size;
  }
}
