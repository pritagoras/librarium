const DB_NAME = 'librarium_local_v1';
const DB_VERSION = 7;

const STORES = [
  'books',
  'notes',
  'entries',
  'conversations',
  'quotes',
  'analyses',
  'characters',
  'characterRelations',
  'media',
  'syncConflicts',
  'syncPending',
] as const;

export type StoreName = (typeof STORES)[number];

let dbInstance: IDBDatabase | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      STORES.forEach((storeName) => {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: 'id' });
        }
      });
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

function getStore(name: StoreName, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
  if (!dbInstance) {
    throw new Error('IndexedDB aún no fue inicializada.');
  }
  return dbInstance.transaction(name, mode).objectStore(name);
}

export function all<T = any>(name: StoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = getStore(name).getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

export function get<T = any>(name: StoreName, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = getStore(name).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export function put<T extends { id: string }>(name: StoreName, obj: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = getStore(name, 'readwrite').put(obj);
    req.onsuccess = () => resolve(obj);
    req.onerror = () => reject(req.error);
  });
}

export function del(name: StoreName, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = getStore(name, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function clearStore(name: StoreName): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = getStore(name, 'readwrite').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllStores(): Promise<void> {
  for (const s of STORES) {
    await clearStore(s);
  }
}
