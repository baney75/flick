// One-time move from the built-in Stremio section to the Stremio plugin. Only a person who used
// Stremio (signed in, added addons, watched something, or synced addons) gets the plugin, with their
// sign-in key and addons moved into it and their progress pointed at it. Everyone else gets nothing.

import * as db from '../db'
import type { Progress, Ref } from '../store'
import { installed, prepare, install, type Deps } from './registry'

export const STREMIO_ID = 'dev.flick.stremio'
export const STREMIO_URL = '/plugins/stremio.js'
const DONE = 'migrated.stremio'

interface OldStremio { authKey?: string | null; email?: string | null; extra?: string[] }
type LegacyRef = { t: 'stremio'; type: string; id: string; videoId: string }

/** A progress row from the built-in Stremio section, as a plugin row. Other rows come back as null. */
export function legacyProgress(key: string, p: Progress): [string, Progress] | null {
  const ref = p.ref as Ref | LegacyRef
  if (ref.t !== 'stremio') return null
  const next: Ref = { t: 'plugin', p: STREMIO_ID, type: ref.type, id: ref.id, videoId: ref.videoId }
  return [`pl:${STREMIO_ID}:${ref.videoId}`, { ...p, ref: next }]
}

/** Addon URLs the sync group had under the old a: keys, read from the stored doc. */
async function syncedAddons(): Promise<string[]> {
  const doc = await db.get<{ rows?: [string, { v: unknown }][] }>('kv', 'sync.doc')
  return (doc?.rows ?? []).filter(([k, e]) => k.startsWith('a:') && e?.v === true).map(([k]) => k.slice(2))
}

export async function migrateStremio(deps?: Deps): Promise<boolean> {
  if (await db.get('kv', DONE)) return false
  const old = (await db.get<OldStremio>('kv', 'stremio')) ?? {}
  const rows = (await db.entries<Progress>('progress')).map(([k, p]) => [k, legacyProgress(k, p)] as const).filter((r) => r[1])
  const addons = [...new Set([...(old.extra ?? []), ...(await syncedAddons())])]
  const used = !!old.authKey || addons.length > 0 || rows.length > 0

  if (used && !installed.value.some((p) => p.id === STREMIO_ID)) {
    // Throws when offline; nothing is marked done, so the next launch tries again.
    await install(await prepare({ url: STREMIO_URL }, deps), { addons })
  }
  if (old.authKey) {
    const data = (await db.get<Record<string, unknown>>('pluginData', STREMIO_ID)) ?? {}
    await db.put('pluginData', STREMIO_ID, { ...data, authKey: old.authKey, email: old.email ?? null })
  }
  for (const [oldKey, row] of rows) {
    const [key, p] = row!
    await db.put('progress', key, p)
    await db.del('progress', oldKey)
  }
  await db.del('kv', 'stremio')
  await db.put('kv', DONE, Date.now())
  return used
}
