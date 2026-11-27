// Tiny IndexedDB wrapper. One database, a few object stores, promise API.

const DB_NAME = 'flick'
// Bump on every new store: onupgradeneeded adds only the stores an existing database lacks. 4: the items
// copy (below); a Flick from before it writes items without its rev, so it must not open this database.
const DB_VERSION = 4
export const STORES = ['items', 'progress', 'kv', 'thumbs', 'downloads', 'plugins', 'pluginData'] as const
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
    req.onsuccess = () => {
      const db = req.result
      // A newer Flick in another tab needs the database: let go so its upgrade is not blocked.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
        if (typeof dispatchEvent === 'function') dispatchEvent(new Event('flick:db-stale'))
      }
      resolve(db)
    }
    req.onblocked = () => { if (typeof dispatchEvent === 'function') dispatchEvent(new Event('flick:db-blocked')) }
    req.onerror = () => { dbPromise = null; reject(req.error) }
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
  if (name === 'items') return putMany(name, [[key, value]])
  await wrap((await store(name, 'readwrite')).put(value, key))
}

export async function del(name: StoreName, key: IDBValidKey): Promise<void> {
  if (name === 'items') return delMany(name, [key])
  await wrap((await store(name, 'readwrite')).delete(key))
}

export async function all<T>(name: StoreName): Promise<T[]> {
  if (name === 'items') return readItems<T>()
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
  if (name === 'items') return writeItems((s) => { for (const [k, v] of rows) s.put(v, k) }, () => rows.map(([k, v]) => [k, clone!(v)]))
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
  if (name === 'items') return writeItems((s) => { for (const k of keys) s.delete(k) }, () => keys.map((k) => [k, GONE]))
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite')
    const s = tx.objectStore(name)
    for (const k of keys) s.delete(k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ---------- the items copy ----------
// WebKit, Flick's webview on macOS and iOS, pays for each record it reads: one getAll of an 11,800 item
// library took 6 to 8 s, and one record holding the same 3 MB of items read back in about 60 ms. So
// the items store, which stays the truth, has a copy in one kv record that reads use.
// 1. Every write to items bumps kv `items.rev` in the same transaction.
// 2. The copy (kv `items.copy`) counts only when its rev is the current `items.rev`. Any other copy is
//    ignored, so a write the copy missed (another tab, a crash before it was saved) can never be lost.
// 3. With no good copy a read reads the store, and saves a copy of what it read unless the rev moved.
// 4. This tab keeps the writes made since the copy it knows, cloned, and folds them into the copy two
//    seconds after the last one. A write from another tab drops them.
// 5. Whenever a save cannot be made, the store is read again and copied once writes have been quiet
//    for two seconds, so the next start still reads one record.

const REV = 'items.rev'
const COPY = 'items.copy'
const GONE = Symbol('gone')
const DELAY = 2000
type Row = [IDBValidKey, unknown]
type Copy = { rev: number; rows: Row[] }
type Mine = { rev: number; base: number; changes: Map<IDBValidKey, unknown> }
/** This tab's writes since copy `base`; `rev` is the items.rev after the last of them. */
let mine: Mine | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let next: 'fold' | 'recopy' = 'fold'
let saved: Promise<void> = Promise.resolve()
// Safari before 15.4 (macOS 12.0 to 12.2) has none. Then this tab keeps no changes and recopies instead.
const clone = typeof structuredClone === 'function' ? structuredClone : null

const revOf = (v: unknown) => (typeof v === 'number' ? v : 0)
const isCopy = (v: unknown): v is Copy => !!v && typeof v === 'object' && typeof (v as Copy).rev === 'number' && Array.isArray((v as Copy).rows)
const byKey = (a: Row, b: Row) => indexedDB.cmp(a[0], b[0])

/** The copy's rows with this tab's changes on top, in key order like getAll. */
function fold(rows: Row[], changes: Map<IDBValidKey, unknown>): Row[] {
  if (!changes.size) return rows
  const m = new Map(rows)
  let added = false
  for (const [k, v] of changes) {
    if (v === GONE) m.delete(k)
    else { if (!m.has(k)) added = true; m.set(k, clone!(v)) }
  }
  const out = [...m]
  return added ? out.sort(byKey) : out
}

/** Runs `what` once writes have been quiet for DELAY; a recopy wins over a fold. */
function soon(what: 'fold' | 'recopy') {
  if (what === 'recopy') next = 'recopy'
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; saved = run() }, DELAY)
}
async function run() {
  // A save still under way decides whether there is anything left to do.
  await saved
  const what = next
  next = 'fold'
  await (what === 'recopy' ? recopy() : saveCopy()).catch(() => {})
}

async function writeItems(apply: (s: IDBObjectStore) => void, changes: () => Row[]): Promise<void> {
  const db = await open()
  let rev = 0
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['items', 'kv'], 'readwrite')
    const kv = tx.objectStore('kv')
    const r = kv.get(REV)
    r.onsuccess = () => { rev = revOf(r.result); kv.put(rev + 1, REV) }
    apply(tx.objectStore('items'))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  if (mine && mine.rev === rev && clone) {
    for (const [k, v] of changes()) mine.changes.set(k, v)
    mine.rev = rev + 1
    soon('fold')
  } else {
    mine = null
    soon('recopy')
  }
}

/** Folds this tab's changes into the copy, if nothing else wrote items since. */
async function saveCopy() {
  const want = mine
  if (!want || !want.changes.size) return
  const db = await open()
  const at = want.rev
  const sent = new Map(want.changes)
  const ok = await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite')
    const kv = tx.objectStore('kv')
    const r = kv.get(REV), c = kv.get(COPY)
    c.onsuccess = () => {
      if (revOf(r.result) !== at || !isCopy(c.result) || c.result.rev !== want.base) { tx.abort(); return }
      kv.put({ rev: at, rows: fold(c.result.rows, sent) } satisfies Copy, COPY)
    }
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => resolve(false)
  })
  if (mine !== want) return
  if (ok) {
    // Changes made while it saved stay for the next save.
    want.base = at
    for (const [k, v] of sent) if (want.changes.get(k) === v) want.changes.delete(k)
  } else if (want.rev !== at) soon('fold') // only this tab wrote meanwhile: fold again at the new rev
  else { mine = null; soon('recopy') }
}

/** Reads the store, with the rev before it, and saves it as the copy unless the rev moved. */
async function fromStore(db: IDBDatabase): Promise<Row[]> {
  const rev = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly')
    const r = tx.objectStore('kv').get(REV)
    r.onsuccess = () => resolve(revOf(r.result))
    tx.onerror = () => reject(tx.error)
  })
  return readStore(db, rev)
}

// The store alone, so kv is not held for the seconds this takes. saveRead checks the rev again.
async function readStore(db: IDBDatabase, rev: number): Promise<Row[]> {
  const rows = await new Promise<Row[]>((resolve, reject) => {
    const tx = db.transaction('items', 'readonly')
    const s = tx.objectStore('items')
    const ks = s.getAllKeys(), vs = s.getAll()
    vs.onsuccess = () => resolve(ks.result.map((k, i): Row => [k, vs.result[i]]))
    tx.onerror = () => reject(tx.error)
  })
  // A copy that cannot be saved never fails the read (a closed connection, a full disk).
  try { saveRead(db, rev, rows) } catch { mine = null }
  return rows
}

async function recopy() {
  if (mine) return
  await fromStore(await open())
  await saved
}

/**
 * Saves what a read of the store found as the copy, unless items changed since the rev read before
 * it. Starts this tab's change list from it, or recopies later when the copy is not saved.
 */
function saveRead(db: IDBDatabase, rev: number, rows: Row[]) {
  const want: Mine = { rev, base: rev, changes: new Map() }
  const tx = db.transaction('kv', 'readwrite')
  const kv = tx.objectStore('kv')
  mine = want
  // The put clones the rows now, before a caller can change the items it is handed.
  const r = kv.get(REV)
  kv.put({ rev, rows } satisfies Copy, COPY)
  r.onsuccess = () => { if (revOf(r.result) !== rev) tx.abort() }
  saved = new Promise((resolve) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => { if (mine === want) { mine = null; soon('recopy') } resolve() }
  })
}

async function readItems<T>(): Promise<T[]> {
  const db = await open()
  const [rev, copy] = await new Promise<[number, Copy | null]>((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly')
    const kv = tx.objectStore('kv')
    const r = kv.get(REV), c = kv.get(COPY)
    c.onsuccess = () => resolve([revOf(r.result), isCopy(c.result) ? c.result : null])
    tx.onerror = () => reject(tx.error)
  })
  if (copy && copy.rev === rev) {
    mine = { rev, base: rev, changes: new Map() }
    return copy.rows.map((x) => x[1] as T)
  }
  if (copy && mine && mine.rev === rev && mine.base === copy.rev) return fold(copy.rows, mine.changes).map((x) => x[1] as T)
  return (await readStore(db, rev)).map((x) => x[1] as T)
}

/** Tests only: runs a pending save now and waits for it, and for any save it leads to. */
export async function copySettled(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if (timer) { clearTimeout(timer); timer = null; saved = run() }
    await saved
    if (!timer) return
  }
}
