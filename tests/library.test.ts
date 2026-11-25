import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { mergeScan, allItems, _test, hash } from '../src/lib/library'

describe('library merge', () => {
  it('adds new files, keeps add dates and durations, drops deleted files', async () => {
    const a = _test.itemFromEntry({ path: '/m/A.2001.mp4', name: 'A.2001.mp4', size: 1, mtime: 1 }, 'm')!
    const b = _test.itemFromEntry({ path: '/m/Show.S01E01.mkv', name: 'Show.S01E01.mkv', size: 2, mtime: 2 }, 'm')!
    expect(a.id).toBe(hash('/m/A.2001.mp4'))
    expect(b).toMatchObject({ show: 'Show', season: 1, episode: 1 })
    await mergeScan('m', [a, b])
    const stored = await allItems()
    expect(stored.length).toBe(2)

    const firstAdded = stored.find((x) => x.id === a.id)!.addedAt
    // Give A a known duration, then rescan with B removed.
    const { saveItems } = await import('../src/lib/library')
    await saveItems([{ ...stored.find((x) => x.id === a.id)!, duration: 42 }])
    const a2 = { ...a, addedAt: firstAdded + 999 }
    await mergeScan('m', [a2])
    const after = await allItems()
    expect(after.map((x) => x.id)).toEqual([a.id])
    expect(after[0].addedAt).toBe(firstAdded)
    expect(after[0].duration).toBe(42)
  })
})
