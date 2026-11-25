// Tiny IndexedDB wrapper. One database, a few object stores, promise API.

const DB_NAME = 'flick'
// Bump on every new store: onupgradeneeded adds only the stores an existing database lacks.
const DB_VERSION = 2
export const STORES = ['items', 'progress', 'kv', 'thumbs', 'downloads'] as const
export type StoreName = (typeof STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(name: StoreName, mode: IDBTransactionMode) {
  const db = await open()
  return db.transaction(name, mode).objectStore(name)
}

export async function get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return wrap((await store(name, 'readonly')).get(key))
}

export async function put(name: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  await wrap((await store(name, 'readwrite')).put(value, key))
}

export async function del(name: StoreName, key: IDBValidKey): Promise<void> {
  await wrap((await store(name, 'readwrite')).delete(key))
}

export async function all<T>(name: StoreName): Promise<T[]> {
  return wrap((await store(name, 'readonly')).getAll())
}

export async function entries<T>(name: StoreName): Promise<[string, T][]> {
  const s = await store(name, 'readonly')
  const [keys, values] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())])
  return keys.map((k, i) => [String(k), values[i] as T])
}

/** Write many records in one transaction. Much faster than one put per record. */
export async function putMany(name: StoreName, rows: [IDBValidKey, unknown][]): Promise<void> {
  if (!rows.length) return
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite')
    const s = tx.objectStore(name)
    for (const [k, v] of rows) s.put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function delMany(name: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite')
    const s = tx.objectStore(name)
    for (const k of keys) s.delete(k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
