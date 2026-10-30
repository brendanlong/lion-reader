/**
 * The IndexedDB store a shared file waits in: the share-target service worker
 * (`service-worker/index.ts`) puts it there and /save uploads it. Both import
 * this module, so they open the database the same way.
 */

export interface SharedFileRecord {
  /** Base64 file content. */
  content: string;
  filename: string;
  /** The MIME type the sharing app gave it. */
  type?: string;
  title?: string;
}

const DB_NAME = "lion-reader-share";
/**
 * 2, not 1: a version-1 database can lack the store, because /save once opened
 * the database before the service worker had created it, and opening an
 * existing database at its own version never runs the upgrade.
 */
const DB_VERSION = 2;
const STORE = "files";
const PENDING_KEY = "pending";

function shareStoreRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

export async function putSharedFile(record: SharedFileRecord): Promise<void> {
  await shareStoreRequest("readwrite", (store) => store.put(record, PENDING_KEY));
}

/** The shared file waiting for /save, if any. */
export async function getSharedFile(): Promise<SharedFileRecord | undefined> {
  return (await shareStoreRequest("readonly", (store) => store.get(PENDING_KEY))) as
    SharedFileRecord | undefined;
}

export async function deleteSharedFile(): Promise<void> {
  await shareStoreRequest("readwrite", (store) => store.delete(PENDING_KEY));
}
