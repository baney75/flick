// Library chips from plugin libraries (SPEC-library-format rules 7 to 11): Flick's own chips take
// plugin items by type, and each plugin shelf with items is a chip of its own.

import type { Library, Meta, Shelf } from './plugins/validate'
import type { Title } from './titles'

export interface ShelfItem { p: string; m: Meta }
export interface ShelfChip { key: string; name: string; layout: NonNullable<Shelf['layout']>; order: NonNullable<Shelf['order']>; items: ShelfItem[] }
export type ShelfKey = `shelf:${string}`

/** Shelves with one name after trim and case fold are one chip, so a saved tab survives a reload. */
export const shelfKey = (name: string): ShelfKey => `shelf:${name.trim().toLowerCase()}`
export const isShelfKey = (t: string): t is ShelfKey => t.startsWith('shelf:')

/** Plugin libraries in install order: one chip per shelf name with items, after Flick's own chips. */
export function shelfChips(libs: { p: string; lib: Library }[]): ShelfChip[] {
  const out = new Map<ShelfKey, ShelfChip & { set: Partial<Shelf>; seen: Set<string> }>()
  for (const { p, lib } of libs) {
    const on = new Map<string, Meta[]>()
    for (const m of lib.items) for (const id of m.shelves ?? []) on.set(id, [...(on.get(id) ?? []), m])
    for (const s of lib.shelves) {
      const key = shelfKey(s.name)
      const chip = out.get(key) ?? { key, name: s.name, layout: 'poster', order: 'plugin', items: [], set: {}, seen: new Set() }
      // The first shelf that says a layout or order decides it; the first spelling names the chip.
      chip.set.layout ??= s.layout
      chip.set.order ??= s.order
      for (const m of on.get(s.id) ?? []) if (!chip.seen.has(`${p}\n${m.id}`)) { chip.seen.add(`${p}\n${m.id}`); chip.items.push({ p, m }) }
      out.set(key, chip)
    }
  }
  return [...out.values()].filter((c) => c.items.length).map(({ set, seen: _, ...c }) => ({ ...c, layout: set.layout ?? commonShape(c.items), order: set.order ?? 'plugin' }))
}

function commonShape(items: ShelfItem[]): ShelfChip['layout'] {
  const n = { poster: 0, square: 0, landscape: 0 }
  for (const { m } of items) if (m.posterShape) n[m.posterShape]++
  const best = (Object.keys(n) as (keyof typeof n)[]).reduce((a, b) => (n[b] > n[a] ? b : a))
  return n[best] ? best : 'poster'
}

const yearNum = (m: Meta) => parseInt(m.year ?? '', 10) || 0
const SORTS: Record<'added' | 'name' | 'year', (a: ShelfItem, b: ShelfItem) => number> = {
  added: (a, b) => (b.m.added ?? 0) - (a.m.added ?? 0),
  name: (a, b) => a.m.name.localeCompare(b.m.name, undefined, { numeric: true }),
  year: (a, b) => yearNum(b.m) - yearNum(a.m),
}

/** A shelf's items in its own order, then by the Sort menu when the user picked one. Both sorts are stable. */
export function shelfOrder(c: ShelfChip, picked?: 'added' | 'title' | 'year'): ShelfItem[] {
  const l = [...c.items]
  if (c.order !== 'plugin') l.sort(SORTS[c.order])
  if (picked) l.sort(SORTS[picked === 'title' ? 'name' : picked])
  return l
}

/** What Library search reads in a plugin item: name, subtitle, badges and fact values. */
export const metaText = (m: Meta) => [m.name, m.subtitle, ...(m.badges ?? []), ...(m.facts ?? []).map((f) => f.value)].filter(Boolean).join(' ')

/** The built-in chip a plugin-only title of another type joins, by its type: Music, Books, Audiobooks, Videos. */
export function typeChip(t: Title): 'music' | 'books' | 'audiobooks' | 'videos' | null {
  if (t.type !== 'other') return null
  const s = t.srcs[0]
  const type = s?.t === 'plugin' ? s.m.type : ''
  return type === 'audio' ? 'music' : type === 'book' ? 'books' : type === 'audiobook' ? 'audiobooks' : type === 'video' || type === 'channel' ? 'videos' : null
}
