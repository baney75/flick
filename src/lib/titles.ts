// One library across folders, servers, downloads and source plugins: the same movie or show from
// several places becomes one title with a list of sources to choose from.

import type { Item } from './library'
import type { Meta } from './plugins/validate'
import { rank, type Device, type PickCtx, type Prefs, type Ranked } from './pick'
import { srcCandidates } from './candidates'

/** One place a title can be played or opened from. */
export type Src =
  // A library item. dl: play the downloaded copy; stream: play from its server even though a copy exists.
  | { t: 'item'; it: Item; dl?: boolean; stream?: boolean }
  | { t: 'show'; name: string; eps: Item[] }
  | { t: 'plugin'; p: string; pname: string; m: Meta }

export interface Title {
  key: string
  type: 'movie' | 'show' | 'other'
  name: string
  year?: number
  srcs: Src[]
  addedAt: number
}

export interface PluginLib { p: string; pname: string; list: Meta[] }

/** Lowercase, no accents or punctuation, single spaces, a leading "the" dropped. */
export function normTitle(s: string): string {
  const n = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return n.replace(/^the /, '')
}

const yearOf = (y: unknown): number | undefined => {
  const n = typeof y === 'number' ? y : parseInt(String(y ?? ''), 10)
  return Number.isFinite(n) && n > 1800 ? n : undefined
}

export function srcKey(s: Src): string {
  if (s.t === 'item') return `${s.dl ? 'dl' : 'item'}:${s.it.id}`
  if (s.t === 'show') return `show:${s.name.toLowerCase()}`
  return `pl:${s.p}:${s.m.id}`
}

/** What the ranker knows besides the sources; with none, no language or quality preference and no limits. */
export interface RankBy { prefs: Prefs; dev: Device; ctx: Omit<PickCtx, 'picked'>; progressAt?: (s: Src) => number | undefined }
const NEUTRAL: RankBy = {
  prefs: { audio: [], subs: [], maxQuality: '4K' },
  dev: { maxQuality: '4K', hdr: false, codecs: {}, desktop: true, phone: false },
  ctx: { gate: true, vpnForDebrid: false, online: true },
}

/** Each source with its ranked row, best first: the hand pick, a download, then by the ranker (pick.ts). */
export function rankedRows(srcs: Src[], picked?: string, by: RankBy = NEUTRAL): { s: Src; r: Ranked }[] {
  const byId = new Map(srcs.map((s) => [srcKey(s), s]))
  return rank(srcCandidates(srcs, by.progressAt), by.prefs, by.dev, { ...by.ctx, picked }).map((r) => ({ s: byId.get(r.c.id)!, r }))
}

/** Sources in the order the chooser lists them, with the one picked last time first. */
export function ranked(srcs: Src[], picked?: string, by?: RankBy): Src[] {
  return rankedRows(srcs, picked, by).map((x) => x.s)
}

interface Entry { type: Title['type']; name: string; year?: number; srcs: Src[]; addedAt: number }

/**
 * Groups movies, shows and plugin library items into titles. Two entries are one title when the
 * type and normalized name match and the years match. An entry with no year joins the one dated
 * title of that name; with two or more dated ones it would be a guess, so it stays its own card.
 * Two items from the same plugin library are never one title (a 1978 and a 2004 series of one name).
 */
export function buildTitles(movies: Item[], shows: Map<string, Item[]>, libs: PluginLib[], saved: (id: string) => boolean): Title[] {
  const entries: Entry[] = []
  for (const it of movies) {
    const srcs: Src[] = saved(it.id) ? [{ t: 'item', it, dl: true }, { t: 'item', it, stream: true }] : [{ t: 'item', it }]
    entries.push({ type: 'movie', name: it.title, year: it.year, srcs, addedAt: it.addedAt })
  }
  for (const eps of shows.values()) {
    entries.push({ type: 'show', name: eps[0].show!, srcs: [{ t: 'show', name: eps[0].show!, eps }], addedAt: Math.max(...eps.map((e) => e.addedAt)) })
  }
  // A plugin item with no `added` sorts after dated titles.
  for (const { p, pname, list } of libs) for (const m of list) {
    const type = m.type === 'movie' ? 'movie' : m.type === 'series' ? 'show' : 'other'
    entries.push({ type, name: m.name, year: type === 'movie' ? yearOf(m.year) : undefined, srcs: [{ t: 'plugin', p, pname, m }], addedAt: m.added ?? 0 })
  }

  const groups = new Map<string, Title[]>()
  const keyOf = (e: Entry) => `${e.type}|${e.type === 'other' ? srcKey(e.srcs[0]) : normTitle(e.name)}`
  const pluginOf = (x: { srcs: Src[] }) => x.srcs.find((s) => s.t === 'plugin')?.p
  const fits = (t: Title, e: Entry) => !pluginOf(e) || !t.srcs.some((s) => s.t === 'plugin' && s.p === pluginOf(e))
  const add = (e: Entry, into?: Title) => {
    if (into) {
      into.srcs.push(...e.srcs)
      into.addedAt = Math.max(into.addedAt, e.addedAt)
      into.year ??= e.year
      return
    }
    const k = keyOf(e)
    const t: Title = { key: '', ...e, srcs: [...e.srcs] }
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  // Dated entries first, so an undated one knows how many dated titles share its name.
  for (const e of entries.filter((x) => x.year !== undefined || x.type === 'show')) {
    add(e, groups.get(keyOf(e))?.find((t) => (e.type === 'show' || t.year === e.year) && fits(t, e)))
  }
  for (const e of entries.filter((x) => x.year === undefined && x.type !== 'show')) {
    const same = (groups.get(keyOf(e)) ?? []).filter((t) => fits(t, e))
    const dated = same.filter((t) => t.year !== undefined)
    add(e, e.type === 'other' ? undefined : dated.length === 1 ? dated[0] : same.find((t) => t.year === undefined))
  }
  // The key names the title's steadiest source, a library item before a plugin one, so a choice
  // remembered under it holds whichever library finished loading first.
  const all = [...groups.values()].flat()
  for (const t of all) t.key = srcKey([...t.srcs].sort((a, b) => Number(a.t === 'plugin') - Number(b.t === 'plugin'))[0]).replace(/^dl:/, 'item:')
  return all
}

/** Short names for a title's badge: "Jellyfin · Stremio". */
export function srcName(s: Src): string {
  if (s.t === 'plugin') return s.pname
  const it = s.t === 'show' ? s.eps[0] : s.it
  if (s.t === 'item' && s.dl) return 'Downloaded'
  return it.origin === 'local' || it.origin === 'stored' ? 'This device' : it.origin === 'flick' ? 'Flick server'
    : it.origin[0].toUpperCase() + it.origin.slice(1)
}

export function badgeOf(t: Title): string {
  return [...new Set(ranked(t.srcs).map(srcName))].join(' · ')
}

type Pos = { pos: number; dur: number; at: number }
/** The fraction watched, from whichever source saved a position last. */
export function latestProgress(t: Title, prog: Record<string, Pos | undefined>, pluginProg: (p: string, m: Meta) => Pos | undefined): number | undefined {
  let best: Pos | undefined
  for (const s of t.srcs) {
    const ps = s.t === 'item' ? [prog[s.it.id]] : s.t === 'show' ? s.eps.map((e) => prog[e.id]) : [pluginProg(s.p, s.m) ?? s.m.progress]
    for (const p of ps) if (p && p.dur && (!best || p.at > best.at)) best = p
  }
  return best ? best.pos / best.dur : undefined
}

// The source picked last time, per title. Kept in this browser only; losing it just means the default order.
const PICKS = 'flick.picks'
export function pickedFor(key: string): string | undefined {
  try { return (JSON.parse(localStorage.getItem(PICKS) ?? '{}') as Record<string, string>)[key] } catch { return undefined }
}
export function remember(key: string, src: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PICKS) ?? '{}') as Record<string, string>
    all[key] = src
    localStorage.setItem(PICKS, JSON.stringify(all))
  } catch { /* storage blocked: the default order still works */ }
}
