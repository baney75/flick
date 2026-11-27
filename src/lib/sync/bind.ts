// Connects app state to the sync doc in both directions.
// Out: progress and settings changes (signals), servers and plugins (bus events) become doc writes.
// In: changed doc keys are applied to local state with echo suppressed, so a value from a
// peer is never re-sent with a new timestamp.

import { effect } from '@preact/signals'
import * as db from '../db'
import { items, progress, settings, setSettings, notify, reloadItems, type Progress, type Settings } from '../store'
import { validPref } from '../prefs'
import { getServers, saveServer, removeServer, syncServer, type Server } from '../servers'
import type { Item } from '../library'
import { contentIndex, localProgressKeys, progressDocKey, pluginSnapshot, mayInstallSynced, mayTakeOverSynced, secretLeaks, type SyncedPlugin } from './keys'
import { installed, prepare, install, remove, setEnabled, setPluginSettings, isSecret, portable } from '../plugins/registry'
import { legacyProgress } from '../plugins/migrate'
import { startSync, publish, docValue, docKeys } from './engine'
import { bus } from './bus'

// Settings that follow the person; volume stays per device.
const SHARED: (keyof Settings)[] = ['autoplayNext', 'skipSeconds', 'theme', 'speed', 'look', 'audio', 'subs', 'maxQuality']

let applying = false
let prevProgress: Record<string, Progress> = {}
let prevServers = new Map<string, string>()
let prevPlugins = new Map<string, string>()

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
  prevPlugins = pluginSnapshot(installed.value)

  // Offer what this device has, without overwriting what the group already holds. The engine
  // calls this on start and again after joining a new group, whose doc starts empty.
  const offer = (): [string, unknown][] => [
    ...progressChanges({}, progress.value),
    ...SHARED.map((k) => [`s:${k}`, settings.value[k]] as [string, unknown]),
    ...[...prevServers].map(([id, s]) => [`v:${id}`, JSON.parse(s)] as [string, unknown]),
    ...[...prevPlugins].map(([k, v]) => [k, JSON.parse(v)] as [string, unknown]),
  ]
  // After each merge from another device (never before one, so a stale copy here cannot undo a newer change
  // there), a synced plugin entry that still holds a field this device keeps secret is rewritten without it.
  await startSync((keys) => { applyRemote(keys).then(() => publish(secretLeaks(installed.value, docValue))).catch(() => {}) }, offer)

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

  bus.addEventListener('plugins', () => {
    const next = pluginSnapshot(installed.value)
    if (!applying) {
      const ch: [string, unknown][] = []
      for (const [k, v] of next) if (prevPlugins.get(k) !== v) ch.push([k, JSON.parse(v)])
      for (const k of prevPlugins.keys()) if (!next.has(k)) ch.push([k, null])
      publish(ch)
    }
    prevPlugins = next
  })

  // Folders added later can match progress the group already has.
  let lastCount = -1
  effect(() => {
    const n = items.value.length
    if (n !== lastCount) { lastCount = n; applyRemote(docKeys('p:i:')).catch(() => {}) }
  })
}

/** Applies changed doc keys to this device. Exported for tests. */
export async function applyRemote(keys: string[]) {
  const index = contentIndex(items.value)
  const prog = { ...progress.value }
  // What the keys change, applied at the end onto the progress as it is then (see below).
  const changed = new Map<string, Progress | null>()
  const settingsPatch: Partial<Settings> = {}
  let servers = false, plugins = false

  for (const k of keys) {
    const v = docValue(k)
    if (k.startsWith('p:')) {
      // A device that still has the built-in Stremio section writes p:k:st:<video>; keep it as a plugin row.
      const legacy = v != null && k.startsWith('p:k:st:') ? legacyProgress(k.slice(4), v as Progress) : null
      if (legacy) {
        const [local, row] = legacy
        if (!prog[local] || prog[local].at < row.at) { prog[local] = row; changed.set(local, row); await db.put('progress', local, row) }
        continue
      }
      for (const local of localProgressKeys(k, index)) {
        if (v == null) {
          if (local in prog) { delete prog[local]; changed.set(local, null); await db.del('progress', local) }
          continue
        }
        const p = v as Progress
        if (prog[local] && prog[local].at >= p.at) continue
        const row: Progress = { ...p, ref: p.ref.t === 'item' ? { t: 'item', id: local } : p.ref }
        prog[local] = row
        changed.set(local, row)
        await db.put('progress', local, row)
      }
    } else if (k.startsWith('s:')) {
      const f = k.slice(2) as keyof Settings
      if (SHARED.includes(f) && v != null && validPref(f, v)) (settingsPatch as Record<string, unknown>)[f] = v
    } else if (k.startsWith('v:')) servers = true
    else if (k.startsWith('x:')) plugins = true
  }

  applying = true
  try {
    // Onto the progress as it is now, not the copy taken before the writes above: a place this device
    // saved while they waited (the player saves as it plays) stays.
    if (changed.size) {
      const now = { ...progress.value }
      for (const [k, row] of changed) {
        if (!row) delete now[k]
        else if (!now[k] || now[k].at < row.at) now[k] = row
      }
      progress.value = now
    }
    if (Object.keys(settingsPatch).length) setSettings(settingsPatch)
  } finally {
    applying = false
  }

  if (servers) await applyServers()
  if (plugins) await applyPlugins()
}

async function applyPlugins() {
  applying = true
  try {
    for (const k of docKeys('x:')) {
      const url = k.slice(2)
      const v = docValue(k) as SyncedPlugin | null
      // Only addresses every device can use: a bundled /plugins/ path or https.
      if (portable(url) !== url) continue
      const local = installed.value.find((p) => p.url && portable(p.url) === url)
      if (v == null) { if (local) await remove(local.id); continue }
      let rec = local
      // Installed on another of this person's devices: fetch it here too. A failure waits for the next change.
      if (!rec) {
        try {
          const c = await prepare({ url })
          // Code that changed since it was reviewed, and asks for more, waits for a review on this device.
          if (!mayInstallSynced(v, c)) { notify(`${c.manifest.name} changed since you added it on another device. Add it in Settings to review it here.`); continue }
          if (!mayTakeOverSynced(c, docValue)) { notify(`${c.manifest.name} from another device would replace ${c.replaces!.manifest.name} here. Add it in Settings to review it here.`); continue }
          rec = await install(c)
        } catch { continue }
      }
      if (rec.enabled !== v.on) await setEnabled(rec.id, v.on)
      const r = rec
      const patch = Object.fromEntries(Object.entries(v.settings ?? {}).filter(([key, val]) => !isSecret(r, key) && JSON.stringify(r.settings[key]) !== JSON.stringify(val)))
      if (Object.keys(patch).length) await setPluginSettings(rec.id, patch)
    }
    prevPlugins = pluginSnapshot(installed.value)
  } finally {
    applying = false
  }
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
