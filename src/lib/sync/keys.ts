// How app state maps onto synced keys.
//   p:i:<content key>  watch progress for a library item
//   p:k:<key>          watch progress for anything else (Stremio, URLs), keyed as on every device
//   a:<addon url>      a Stremio addon added by URL (true, or null once removed)
//   v:<server id>      a Plex or Jellyfin server connection
//   s:settings         player settings
//
// A file in a local folder has a different path, and so a different item id, on each device.
// Progress for it syncs under a content key built from the parsed name instead, so
// "Show S01E02" on the Mac and the same episode on the phone share one position.

import type { Item } from '../library'
import type { Progress } from '../store'

const LOCAL = new Set(['local', 'stored'])

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export function contentKey(i: Pick<Item, 'id' | 'origin' | 'kind' | 'title' | 'show' | 'season' | 'episode' | 'year'>): string {
  // Server items have the same id on every device that connects to the same server.
  if (!LOCAL.has(i.origin)) return `id:${i.id}`
  if (i.show) return `ep:${norm(i.show)}:${i.season ?? 1}:${i.episode ?? 0}`
  return `${i.kind === 'audio' ? 'au' : 'mv'}:${norm(i.title)}:${i.year ?? ''}`
}

// The synced key for a progress row here, or null when the item is gone from this library.
export function progressDocKey(key: string, p: Pick<Progress, 'ref'>, byId: Map<string, Item>): string | null {
  if (p.ref.t !== 'item') return `p:k:${key}`
  const it = byId.get(p.ref.id)
  return it ? `p:i:${contentKey(it)}` : null
}

// The local progress keys a synced progress key lands on. An item key can match several
// copies of the same episode; one with no match here is kept in the doc until it shows up.
export function localProgressKeys(docKey: string, byContent: Map<string, string[]>): string[] {
  if (docKey.startsWith('p:k:')) return [docKey.slice(4)]
  if (docKey.startsWith('p:i:')) return byContent.get(docKey.slice(4)) ?? []
  return []
}

export function contentIndex(items: Item[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const it of items) {
    const k = contentKey(it)
    const l = m.get(k)
    if (l) l.push(it.id)
    else m.set(k, [it.id])
  }
  return m
}
