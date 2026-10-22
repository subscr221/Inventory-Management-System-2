import type { QueuedLabel } from '../components/label-queue-model';

/**
 * Story 3.15: GRN labels waiting to be printed, device-local. Plain IndexedDB like
 * pending-photos.ts; no PowerSync table and no owner column, because a label belongs to the device
 * that completed the receipt.
 */

const DATABASE_NAME = 'inventory-edge-labels';
const STORE_NAME = 'grn_labels';
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
        const store = req.result.createObjectStore(STORE_NAME, { keyPath: 'grn_line_id' });
        store.createIndex('by_grn', 'grn_id', { unique: false });
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

export const labelStore = {
  async putMany(labels: QueuedLabel[]): Promise<void> {
    if (labels.length === 0) return;
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const store = tx.objectStore(STORE_NAME);
    for (const label of labels) store.put(label);
    await done;
  },

  async listByGrn(grnId: string): Promise<QueuedLabel[]> {
    const db = await openDatabase();
    const rows = await new Promise<QueuedLabel[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('by_grn').getAll(grnId);
      req.onsuccess = () => resolve(req.result as QueuedLabel[]);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
    return rows.sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0));
  },

  async markPrinted(grnLineId: string, printedAt = new Date().toISOString()): Promise<void> {
    const label = await withStore<QueuedLabel | undefined>('readonly', (store) =>
      store.get(grnLineId),
    );
    if (!label) return;
    await withStore('readwrite', (store) =>
      store.put({ ...label, status: 'printed', printed_at: printedAt }),
    );
  },
};
