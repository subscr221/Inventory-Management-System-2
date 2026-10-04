/**
 * Story 8.9 (Task 9.2, D14): photos waiting to upload, kept as the original Blobs in a dedicated
 * IndexedDB store. Not a PowerSync table: originals are several megabytes and must never ride the
 * site bucket. Plain IndexedDB API, no dependency.
 */
export interface PendingPhoto {
  /** Client-minted; the damage report carries it as `photo_attachment_id`. */
  attachmentId: string;
  blob: Blob;
  /** The file's own type as taken (image/jpeg, image/png, image/webp, image/heic, image/heif). */
  contentType: string;
  /** Uploads go out only under their owner's session (the Story 1.12 outbox rule). */
  ownerUserId: string;
  createdAt: string;
}

export interface PendingPhotoStore {
  put(photo: PendingPhoto): Promise<void>;
  list(): Promise<PendingPhoto[]>;
  remove(attachmentId: string): Promise<void>;
}

const DATABASE_NAME = 'inventory-edge-photos';
const STORE_NAME = 'pending_photos';
const VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let opened: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (opened) return opened;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available on this device'));
  }
  opened = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DATABASE_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'attachmentId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  }).catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const [result] = await Promise.all([request(work(tx.objectStore(STORE_NAME))), done]);
  return result;
}

export const pendingPhotoStore: PendingPhotoStore = {
  async put(photo) {
    await withStore('readwrite', (store) => store.put(photo));
  },
  async list() {
    const rows = await withStore('readonly', (store) => store.getAll() as IDBRequest<PendingPhoto[]>);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async remove(attachmentId) {
    await withStore('readwrite', (store) => store.delete(attachmentId));
  },
};
