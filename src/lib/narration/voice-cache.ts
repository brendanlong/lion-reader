/**
 * IndexedDB storage for Piper TTS voice models.
 *
 * Provides persistent caching of downloaded voice models with CRUD operations
 * and storage size calculation.
 *
 * @module narration/voice-cache
 */

/**
 * Represents a cached voice model entry in IndexedDB.
 */
export interface VoiceCacheEntry {
  /**
   * Primary key - the voice model ID (e.g., "en_US-lessac-medium").
   */
  voiceId: string;

  /**
   * The .onnx model file data.
   */
  modelData: ArrayBuffer;

  /**
   * The .onnx.json config file content.
   */
  configData: string;

  /**
   * Timestamp when the voice was downloaded (milliseconds since epoch).
   */
  downloadedAt: number;

  /**
   * Model version for cache invalidation.
   */
  version: string;
}

/**
 * Database name for voice cache storage.
 */
const DB_NAME = "lion-reader-voice-cache";

/**
 * Object store name for voice entries.
 */
const STORE_NAME = "voices";

/**
 * Current database version.
 */
const DB_VERSION = 1;

/**
 * Storage limit in bytes (200 MB) - used for warning users.
 */
export const STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;

/**
 * Class for managing voice model caching in IndexedDB.
 *
 * Provides persistent storage for downloaded Piper TTS voice models
 * with operations for storing, retrieving, and managing cached voices.
 *
 * @example
 * ```ts
 * const cache = new VoiceCache();
 *
 * // Store a voice
 * await cache.put({
 *   voiceId: "en_US-lessac-medium",
 *   modelData: modelBuffer,
 *   configData: configJson,
 *   downloadedAt: Date.now(),
 *   version: "1.0",
 * });
 *
 * // Retrieve a voice
 * const entry = await cache.get("en_US-lessac-medium");
 * if (entry) {
 *   console.log("Voice found:", entry.voiceId);
 * }
 *
 * // Check storage usage
 * const totalBytes = await cache.getStorageSize();
 * console.log(`Using ${totalBytes} bytes of storage`);
 * ```
 */
export class VoiceCache {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Checks if IndexedDB is available in the current environment.
   *
   * @returns true if IndexedDB can be used, false otherwise.
   */
  static isAvailable(): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    return "indexedDB" in window && window.indexedDB !== null;
  }

  /**
   * Opens or creates the IndexedDB database.
   *
   * @returns Promise resolving to the database instance.
   * @throws Error if IndexedDB is not available or database cannot be opened.
   */
  private async openDatabase(): Promise<IDBDatabase> {
    // Return existing database if already open
    if (this.db) {
      return this.db;
    }

    // Return pending promise if database is being opened
    if (this.dbPromise) {
      return this.dbPromise;
    }

    // Open new database connection
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!VoiceCache.isAvailable()) {
        reject(new Error("IndexedDB is not available"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        this.dbPromise = null;
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create the voices object store with voiceId as the key path
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "voiceId" });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Retrieves a cached voice by its ID.
   *
   * @param voiceId - The voice model ID to retrieve.
   * @returns Promise resolving to the cache entry, or undefined if not found.
   *
   * @example
   * ```ts
   * const entry = await cache.get("en_US-lessac-medium");
   * if (entry) {
   *   const config = JSON.parse(entry.configData);
   *   // Use entry.modelData with Piper TTS
   * }
   * ```
   */
  async get(voiceId: string): Promise<VoiceCacheEntry | undefined> {
    const db = await this.openDatabase();

    return new Promise<VoiceCacheEntry | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(voiceId);

      request.onerror = () => {
        reject(new Error(`Failed to get voice: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve(request.result as VoiceCacheEntry | undefined);
      };
    });
  }

  /**
   * Stores or updates a voice in the cache.
   *
   * @param entry - The voice cache entry to store.
   * @throws Error if the storage operation fails.
   *
   * @example
   * ```ts
   * await cache.put({
   *   voiceId: "en_US-lessac-medium",
   *   modelData: modelArrayBuffer,
   *   configData: JSON.stringify(config),
   *   downloadedAt: Date.now(),
   *   version: "1.0",
   * });
   * ```
   */
  async put(entry: VoiceCacheEntry): Promise<void> {
    const db = await this.openDatabase();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(entry);

      request.onerror = () => {
        reject(new Error(`Failed to store voice: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Deletes a voice from the cache.
   *
   * @param voiceId - The voice model ID to delete.
   * @returns Promise resolving to true if the voice was deleted, false if it didn't exist.
   *
   * @example
   * ```ts
   * const wasDeleted = await cache.delete("en_US-lessac-medium");
   * if (wasDeleted) {
   *   console.log("Voice removed from cache");
   * }
   * ```
   */
  async delete(voiceId: string): Promise<boolean> {
    const db = await this.openDatabase();

    // First check if the entry exists
    const existing = await this.get(voiceId);
    if (!existing) {
      return false;
    }

    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(voiceId);

      request.onerror = () => {
        reject(new Error(`Failed to delete voice: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve(true);
      };
    });
  }

  /**
   * Lists all cached voices.
   *
   * @returns Promise resolving to an array of all cached voice entries.
   *
   * @example
   * ```ts
   * const voices = await cache.list();
   * console.log(`${voices.length} voices cached`);
   * for (const voice of voices) {
   *   console.log(`- ${voice.voiceId} (v${voice.version})`);
   * }
   * ```
   */
  async list(): Promise<VoiceCacheEntry[]> {
    const db = await this.openDatabase();

    return new Promise<VoiceCacheEntry[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to list voices: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve(request.result as VoiceCacheEntry[]);
      };
    });
  }

  /**
   * Calculates the total storage size of all cached voices.
   *
   * Includes both modelData (ArrayBuffer) and configData (string) sizes.
   *
   * @returns Promise resolving to the total size in bytes.
   *
   * @example
   * ```ts
   * const totalBytes = await cache.getStorageSize();
   * const totalMB = totalBytes / (1024 * 1024);
   * console.log(`Using ${totalMB.toFixed(1)} MB of storage`);
   *
   * if (totalBytes > STORAGE_LIMIT_BYTES) {
   *   console.warn("Storage limit exceeded!");
   * }
   * ```
   */
  async getStorageSize(): Promise<number> {
    const entries = await this.list();

    return entries.reduce((total, entry) => {
      // modelData is an ArrayBuffer, so we use byteLength
      const modelSize = entry.modelData.byteLength;

      // configData is a string, estimate size as 2 bytes per character (UTF-16)
      // In reality, for JSON ASCII strings, this overestimates, but it's safer
      const configSize = entry.configData.length * 2;

      // Also account for metadata (voiceId, version, downloadedAt)
      // This is a rough estimate: string lengths * 2 + 8 bytes for number
      const metadataSize = entry.voiceId.length * 2 + entry.version.length * 2 + 8;

      return total + modelSize + configSize + metadataSize;
    }, 0);
  }

  /**
   * Checks if the total cache size exceeds the storage limit.
   *
   * @returns Promise resolving to true if storage exceeds 200 MB.
   *
   * @example
   * ```ts
   * if (await cache.isStorageLimitExceeded()) {
   *   showWarning("Voice cache is using a lot of storage. Consider removing unused voices.");
   * }
   * ```
   */
  async isStorageLimitExceeded(): Promise<boolean> {
    const size = await this.getStorageSize();
    return size > STORAGE_LIMIT_BYTES;
  }

  /**
   * Closes the database connection.
   *
   * Call this when the cache is no longer needed to free resources.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbPromise = null;
  }

  /**
   * Deletes the entire voice cache database.
   *
   * Use with caution - this removes all cached voices and cannot be undone.
   *
   * @returns Promise resolving when the database is deleted.
   *
   * @example
   * ```ts
   * // Clear all cached voices
   * await cache.deleteDatabase();
   * console.log("All cached voices removed");
   * ```
   */
  async deleteDatabase(): Promise<void> {
    // Close existing connection first
    this.close();

    return new Promise<void>((resolve, reject) => {
      if (!VoiceCache.isAvailable()) {
        reject(new Error("IndexedDB is not available"));
        return;
      }

      const request = indexedDB.deleteDatabase(DB_NAME);

      request.onerror = () => {
        reject(
          new Error(`Failed to delete database: ${request.error?.message ?? "Unknown error"}`)
        );
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }
}
