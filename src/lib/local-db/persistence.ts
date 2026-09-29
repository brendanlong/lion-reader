/**
 * Local persistence for the entry store: an IndexedDB database per user that
 * mirrors the synced layer of the store's collections, so entries and list
 * membership survive reloads (see "Local Persistence" in src/FRONTEND_STATE.md).
 *
 * Only server data is stored (never optimistic state), and everything loaded
 * from it is revalidated by the fetches that would happen anyway, so it is a
 * startup cache: losing it, or a write that doesn't land, only costs speed.
 * That's why writes are fire-and-forget and failures are logged, not thrown.
 */

const DATABASE_PREFIX = "lion-reader-local-";
const DATABASE_VERSION = 1;
const DELETE_TIMEOUT_MS = 1000;

/** One object store per persisted collection, plus list fetch times for eviction. */
export type PersistedStoreName = "entries" | "listRows" | "listFetches";

const STORE_KEY_PATHS: Record<PersistedStoreName, string> = {
  entries: "id",
  listRows: "key",
  listFetches: "listKey",
};

export interface ListFetch {
  listKey: string;
  fetchedAt: number;
}

export interface LocalPersistence {
  loadAll: <T>(store: PersistedStoreName) => Promise<T[]>;
  put: (store: PersistedStoreName, rows: object[]) => void;
  delete: (store: PersistedStoreName, keys: string[]) => void;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function databaseName(userId: string): string {
  return `${DATABASE_PREFIX}${userId}`;
}

/** Whether this browser can persist at all (no IndexedDB in some private modes). */
export function isLocalPersistenceSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Opens (creating on first use) the user's database. Databases of any other
 * user found on this browser are deleted: logout wipes the local database, but
 * a session that simply expired never got the chance.
 */
export async function openLocalPersistence(userId: string): Promise<LocalPersistence> {
  await deleteDatabases((name) => name !== databaseName(userId));

  const request = indexedDB.open(databaseName(userId), DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const [store, keyPath] of Object.entries(STORE_KEY_PATHS)) {
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
    }
  };
  const db = await requestToPromise(request);
  // Another tab deleting the database (toggle off, logout, kill switch) must
  // not be blocked by this connection.
  db.onversionchange = () => db.close();

  const write = (store: PersistedStoreName, apply: (objectStore: IDBObjectStore) => void) => {
    try {
      const transaction = db.transaction(store, "readwrite");
      apply(transaction.objectStore(store));
      transaction.onerror = () => console.warn(`Local persistence write failed`, transaction.error);
    } catch (error) {
      // Closed by a delete in another tab, or quota exceeded: persistence is
      // best-effort, so keep running from memory.
      console.warn(`Local persistence write failed`, error);
    }
  };

  return {
    loadAll: async <T>(store: PersistedStoreName): Promise<T[]> => {
      const transaction = db.transaction(store, "readonly");
      return (await requestToPromise(transaction.objectStore(store).getAll())) as T[];
    },
    put: (store, rows) => {
      if (rows.length === 0) return;
      write(store, (objectStore) => {
        for (const row of rows) objectStore.put(row);
      });
    },
    delete: (store, keys) => {
      if (keys.length === 0) return;
      write(store, (objectStore) => {
        for (const key of keys) objectStore.delete(key);
      });
    },
  };
}

async function deleteDatabases(shouldDelete: (name: string) => boolean): Promise<void> {
  // `databases()` is missing only in browsers too old to matter here; without
  // it there is nothing to enumerate.
  if (!isLocalPersistenceSupported() || typeof indexedDB.databases !== "function") return;
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((database) => database.name)
      .filter((name): name is string => !!name && name.startsWith(DATABASE_PREFIX))
      .filter(shouldDelete)
      .map((name) => requestToPromise(indexedDB.deleteDatabase(name)))
  );
}

/**
 * Deletes every local database on this browser (logout, toggling persistence
 * off, kill switch). Resolves after at most `DELETE_TIMEOUT_MS` even if a
 * connection somewhere blocks the delete, so callers can navigate away
 * regardless; the delete completes once the connection closes.
 */
export function deleteLocalPersistence(): Promise<void> {
  const deleted = deleteDatabases(() => true).catch((error: unknown) => {
    console.warn("Failed to delete local persistence", error);
  });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, DELETE_TIMEOUT_MS));
  return Promise.race([deleted, timeout]);
}
