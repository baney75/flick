import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import type { Item } from '../src/lib/library'
import type { Download } from '../src/lib/downloads'

const shell = vi.hoisted(() => {
  Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} })
  return { desktop: false }
})
vi.mock('../src/lib/platform', async (orig) => ({
  ...(await orig<typeof import('../src/lib/platform')>()),
  get isDesktop() { return shell.desktop },
}))
const { canDownload, badgeFor, watchedDownloads, isSaved } = await import('../src/lib/offline')

const item = (over: Partial<Item>): Item => ({ id: 'a', title: 'A', kind: 'video', src: { t: 'url', url: 'https://x/a.mp4' }, origin: 'jellyfin', size: 0, mtime: 0, addedAt: 0, ...over })
const row = (over: Partial<Download>): Download => ({ id: 'a', state: 'done', done: 10, total: 10, at: 1, ...over })

describe('offline helpers', () => {
  it('offers downloads only for server items, and Kodi only in the app', () => {
    expect(canDownload(item({}))).toBe(true)
    expect(canDownload(item({ origin: 'plex' }))).toBe(true)
    expect(canDownload(item({ origin: 'local', src: { t: 'path', path: '/m/a.mp4' } }))).toBe(false)
    expect(canDownload(item({ origin: 'stored', src: { t: 'opfs', name: 'x' } }))).toBe(false)
    const kodi = item({ origin: 'kodi', src: { t: 'kodi', server: 'k', url: 'http://k/vfs/a' } })
    expect(canDownload(kodi)).toBe(false)
    shell.desktop = true
    expect(canDownload(kodi)).toBe(true)
    shell.desktop = false
  })

  it('labels each state', () => {
    expect(badgeFor(undefined)).toBeUndefined()
    expect(badgeFor(row({}))).toBe('Offline')
    expect(badgeFor(row({ state: 'queued' }))).toBe('Queued')
    expect(badgeFor(row({ state: 'downloading', done: 42, total: 100 }))).toBe('42%')
    expect(badgeFor(row({ state: 'downloading', total: 0 }))).toBe('Starting')
    expect(badgeFor(row({ state: 'failed', error: 'Canceled' }))).toBeUndefined()
    expect(badgeFor(row({ state: 'failed', error: 'HTTP 500' }))).toBe('Failed')
    expect(isSaved(row({ state: 'failed' }))).toBe(false)
    expect(isSaved(row({ state: 'queued' }))).toBe(true)
  })

  it('finds only finished downloads that were watched', () => {
    const rows = new Map([
      ['w', row({ id: 'w' })],
      ['half', row({ id: 'half' })],
      ['busy', row({ id: 'busy', state: 'downloading' })],
      ['new', row({ id: 'new' })],
    ])
    const prog = { w: { pos: 95, dur: 100 }, half: { pos: 50, dur: 100 }, busy: { pos: 99, dur: 100 } }
    expect(watchedDownloads(rows, prog)).toEqual(['w'])
  })
})
