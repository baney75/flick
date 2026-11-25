// Connects app state to the sync doc in both directions.
// Out: progress and settings changes (signals), servers and addons (bus events) become doc writes.
// In: changed doc keys are applied to local state with echo suppressed, so a value from a
// peer is never re-sent with a new timestamp.

import { effect } from '@preact/signals'
import * as db from '../db'
import { items, progress, settings, setSettings, reloadItems, saveStremio, stremioExtra, loadStremio, type Progress, type Settings } from '../store'
import { getServers, saveServer, removeServer, syncServer, type Server } from '../servers'
import type { Item } from '../library'
import { contentIndex, localProgressKeys, progressDocKey } from './keys'
import { startSync, publish, seed, docValue, docKeys } from './engine'
import { bus } from './bus'

// Settings that follow the person; volume stays per device.
const SHARED: (keyof Settings)[] = ['autoplayNext', 'skipSeconds', 'theme', 'speed']

let applying = false
let prevProgress: Record<string, Progress> = {}
let prevServers = new Map<string, string>()
let prevAddons = new Set<string>()

const byId = () => new Map(items.value.map((i) => [i.id, i] as [string, Item]))

function progressChanges(prev: Record<string, Progress>, next: Record<string, Progress>): [string, unknown][] {
  const ids = byId()
  const out: [string, unknown][] = []
  for (const [k, p] of Object.entries(next)) {
    if (prev[k] === p) continue
    const dk = progressDocKey(k, p, ids)
    if (dk) out.push([dk, { ...p, ref: p.ref.t === 'item' ? { t: 'item', id: '' } : p.ref }])
  }
  for (const [k, p] of Object.entries(prev)) {
    if (k in next) continue
    const dk = progressDocKey(k, p, ids)
    if (dk) out.push([dk, null])
  }
  return out
}

async function serverSnapshot() {
  return new Map((await getServers()).map((s) => [s.id, JSON.stringify(s)]))
}

export async function startSyncBinding() {
  prevProgress = progress.value
  prevServers = await serverSnapshot()
  prevAddons = new Set(await stremioExtra())

  await startSync((keys) => { applyRemote(keys).catch(() => {}) })

  // First join: offer what this device has, without overwriting what the group already holds.
  seed([
    ...progressChanges({}, progress.value),
    ...SHARED.map((k) => [`s:${k}`, settings.value[k]] as [string, unknown]),
    ...[...prevServers].map(([id, s]) => [`v:${id}`, JSON.parse(s)] as [string, unknown]),
    ...[...prevAddons].map((u) => [`a:${u}`, true] as [string, unknown]),
  ])

  effect(() => {
    const next = progress.value
    if (!applying) publish(progressChanges(prevProgress, next))
    prevProgress = next
  })

  let prevSettings = settings.value
  effect(() => {
    const s = settings.value
    if (!applying) publish(SHARED.filter((k) => s[k] !== prevSettings[k]).map((k) => [`s:${k}`, s[k]]))
    prevSettings = s
  })

  bus.addEventListener('servers', async () => {
    const echo = applying
    const next = await serverSnapshot()
    if (!echo) {
      const ch: [string, unknown][] = []
      for (const [id, s] of next) if (prevServers.get(id) !== s) ch.push([`v:${id}`, JSON.parse(s)])
      for (const id of prevServers.keys()) if (!next.has(id)) ch.push([`v:${id}`, null])
      publish(ch)
    }
    prevServers = next
  })

  bus.addEventListener('addons', async () => {
    const echo = applying
    const next = new Set(await stremioExtra())
    if (!echo) {
      publish([
        ...[...next].filter((u) => !prevAddons.has(u)).map((u) => [`a:${u}`, true] as [string, unknown]),
        ...[...prevAddons].filter((u) => !next.has(u)).map((u) => [`a:${u}`, null] as [string, unknown]),
      ])
    }
    prevAddons = next
  })

  // Folders added later can match progress the group already has.
  let lastCount = -1
  effect(() => {
    const n = items.value.length
    if (n !== lastCount) { lastCount = n; applyRemote(docKeys('p:i:')).catch(() => {}) }
  })
}

async function applyRemote(keys: string[]) {
  const index = contentIndex(items.value)
  const prog = { ...progress.value }
  let progChanged = false
  const settingsPatch: Partial<Settings> = {}
  let servers = false, addons = false

  for (const k of keys) {
    const v = docValue(k)
    if (k.startsWith('p:')) {
      for (const local of localProgressKeys(k, index)) {
        if (v == null) {
          if (local in prog) { delete prog[local]; progChanged = true; await db.del('progress', local) }
          continue
        }
        const p = v as Progress
        if (prog[local] && prog[local].at >= p.at) continue
        const row: Progress = { ...p, ref: p.ref.t === 'item' ? { t: 'item', id: local } : p.ref }
        prog[local] = row
        progChanged = true
        await db.put('progress', local, row)
      }
    } else if (k.startsWith('s:')) {
      const f = k.slice(2) as keyof Settings
      if (SHARED.includes(f) && v != null) (settingsPatch as Record<string, unknown>)[f] = v
    } else if (k.startsWith('v:')) servers = true
    else if (k.startsWith('a:')) addons = true
  }

  applying = true
  try {
    if (progChanged) progress.value = prog
    if (Object.keys(settingsPatch).length) setSettings(settingsPatch)
  } finally {
    applying = false
  }

  if (servers) await applyServers()
  if (addons) await applyAddons()
}

async function applyServers() {
  applying = true
  try {
    const local = new Map((await getServers()).map((s) => [s.id, s]))
    for (const k of docKeys('v:')) {
      const v = docValue(k) as Server | null
      const id = k.slice(2)
      if (v == null && local.has(id)) await removeServer(local.get(id)!)
      else if (v && JSON.stringify(local.get(id)) !== JSON.stringify(v)) {
        await saveServer(v)
        syncServer(v).then(reloadItems).catch(() => {})
      }
    }
    prevServers = await serverSnapshot()
    await reloadItems()
  } finally {
    applying = false
  }
}

async function applyAddons() {
  applying = true
  try {
    const extra = docKeys('a:').filter((k) => docValue(k) === true).map((k) => k.slice(2))
    const before = new Set(await stremioExtra())
    if (extra.length === before.size && extra.every((u) => before.has(u))) return
    await saveStremio({ extra })
    prevAddons = new Set(extra)
    await loadStremio()
  } finally {
    applying = false
  }
}
