import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The items copy in src/lib/db.ts. A fresh import of the module stands for a new launch, or another tab.
type Db = typeof import('../src/lib/db')
const launch = async (): Promise<Db> => { vi.resetModules(); return import('../src/lib/db') }
const it3 = (id: string, title = id) => ({ id, title })

/** A write that skips db.ts: what another tab's db.ts does when `bump`, or a raw write when not. */
async function raw(fn: (items: IDBObjectStore, kv: IDBObjectStore) => void, bump: boolean) {
  const db = await new Promise<IDBDatabase>((ok, no) => { const r = indexedDB.open('flick'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
  await new Promise<void>((ok, no) => {
    const tx = db.transaction(['items', 'kv'], 'readwrite')
    const kv = tx.objectStore('kv')
    fn(tx.objectStore('items'), kv)
    if (bump) { const r = kv.get('items.rev'); r.onsuccess = () => kv.put((r.result ?? 0) + 1, 'items.rev') }
    tx.oncomplete = () => ok()
    tx.onerror = () => no(tx.error)
  })
  db.close()
}
const ids = (l: { id: string }[]) => l.map((x) => x.id)

beforeEach(() => { (globalThis as any).indexedDB = new IDBFactory() })

describe('items copy', () => {
  it('an empty library reads as empty', async () => {
    const db = await launch()
    expect(await db.all('items')).toEqual([])
  })

  it('reads come back in key order, as getAll gives them', async () => {
    const db = await launch()
    await db.putMany('items', [['c', it3('c')], ['a', it3('a')], ['b', it3('b')]])
    expect(ids(await db.all('items'))).toEqual(['a', 'b', 'c'])
    await db.copySettled()
    const next = await launch()
    expect(ids(await next.all('items'))).toEqual(['a', 'b', 'c'])
  })

  it('the next launch reads the copy, not the store', async () => {
    const db = await launch()
    await db.putMany('items', [['a', it3('a')], ['b', it3('b')]])
    await db.all('items')
    await db.copySettled()
    // Only the store has this row, so a read that shows it read the store.
    await raw((items) => items.put(it3('x'), 'x'), false)
    const next = await launch()
    expect(ids(await next.all('items'))).toEqual(['a', 'b'])
  })

  it('a write in this tab is in the next read and, once folded in, in the next launch', async () => {
    const db = await launch()
    await db.putMany('items', [['a', it3('a')], ['b', it3('b')]])
    await db.all('items')
    await db.copySettled()
    await db.putMany('items', [['c', it3('c')], ['a', it3('a', 'A2')]])
    await db.delMany('items', ['b'])
    await db.put('items', 'd', it3('d'))
    const now = await db.all<{ id: string; title: string }>('items')
    expect(now).toEqual([it3('a', 'A2'), it3('c'), it3('d')])
    await db.copySettled()
    await raw((items) => items.put(it3('x'), 'x'), false)
    const next = await launch()
    expect(await next.all('items')).toEqual([it3('a', 'A2'), it3('c'), it3('d')])
  })

  it('another tab\'s write makes the copy stale: the store is read', async () => {
    const db = await launch()
    await db.putMany('items', [['a', it3('a')]])
    await db.all('items')
    await db.copySettled()
    await raw((items) => items.put(it3('b'), 'b'), true)
    expect(ids(await db.all('items'))).toEqual(['a', 'b'])
    const next = await launch()
    expect(ids(await next.all('items'))).toEqual(['a', 'b'])
  })

  it('this tab\'s unsaved writes are dropped, not lost, when another tab writes too', async () => {
    const db = await launch()
    await db.putMany('items', [['a', it3('a')]])
    await db.all('items')
    await db.copySettled()
    await db.putMany('items', [['b', it3('b')]])
    await raw((items) => items.put(it3('c'), 'c'), true)
    await db.putMany('items', [['d', it3('d')]])
    await db.copySettled()
    expect(ids(await db.all('items'))).toEqual(['a', 'b', 'c', 'd'])
    const next = await launch()
    expect(ids(await next.all('items'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a copy left from another rev is ignored', async () => {
    const db = await launch()
    await db.putMany('items', [['a', it3('a')]])
    await raw((_, kv) => kv.put({ rev: 999, rows: [['z', it3('z')]] }, 'items.copy'), false)
    expect(ids(await db.all('items'))).toEqual(['a'])
    await raw((_, kv) => kv.put('not a copy', 'items.copy'), true)
    const next = await launch()
    expect(ids(await next.all('items'))).toEqual(['a'])
  })

  it('changing an item a read handed out does not change the next read', async () => {
    const db = await launch()
    const mine = it3('a')
    await db.putMany('items', [['a', mine]])
    mine.title = 'changed after the write'
    const got = await db.all<{ title: string }>('items')
    expect(got[0].title).toBe('a')
    got[0].title = 'changed after the read'
    await db.copySettled()
    expect((await db.all<{ title: string }>('items'))[0].title).toBe('a')
    expect((await (await launch()).all<{ title: string }>('items'))[0].title).toBe('a')
  })

  it('other stores keep plain reads and writes', async () => {
    const db = await launch()
    await db.put('kv', 'k', 1)
    await db.putMany('progress', [['p', { pos: 1 }]])
    expect(await db.all('progress')).toEqual([{ pos: 1 }])
    expect(await db.get('kv', 'items.rev')).toBeUndefined()
  })
})
