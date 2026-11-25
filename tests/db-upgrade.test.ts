import 'fake-indexeddb/auto'
import { it, expect } from 'vitest'
import * as db from '../src/lib/db'

it('lets a newer Flick in another tab upgrade the database', async () => {
  await db.put('kv', 'k', 1)
  const events: string[] = []
  ;(globalThis as any).dispatchEvent = (e: Event) => { events.push(e.type); return true }
  const newer = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('flick', 99)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('blocked by the open tab'))
  })
  expect(newer.version).toBe(99)
  expect(events).toContain('flick:db-stale')
  newer.close()
})
