// The one update check: the app (desktop, through the Tauri updater and GitHub Releases) and the
// installed plugins together, at launch and every 24 hours. The rules live in ./updates.

import { computed, signal } from '@preact/signals'
import { isDesktop, isMobileApp } from './platform'
import { installed, checkUpdates } from './plugins/registry'
import { notify, nowPlaying, route } from './store'
import * as U from './updates'
import { version as buildVersion } from '../../package.json'

const KEY = 'flick.updates'
const HOUR = 60 * 60 * 1000

export const appUpdates = U.updaterEnabled(isDesktop, isMobileApp)

function load(): U.UpdateState {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { ...U.initial, lastCheck: Number(j.lastCheck) || 0, lastVersion: typeof j.lastVersion === 'string' ? j.lastVersion : '' }
  } catch { return U.initial }
}
export const updates = signal<U.UpdateState>(load())
function save(s: U.UpdateState) {
  updates.value = s
  try { localStorage.setItem(KEY, JSON.stringify({ lastCheck: s.lastCheck, lastVersion: s.lastVersion })) } catch { /* private mode: check again next launch */ }
}

export const version = signal(buildVersion)
let versionRead: Promise<void> | null = null
function readVersion() {
  versionRead ??= appUpdates
    ? import('@tauri-apps/api/app').then((a) => a.getVersion()).then((v) => { version.value = v }, () => {})
    : Promise.resolve()
  return versionRead
}

/** Something plays (the player is open, or an audiobook page), so the banner waits. */
export const playing = computed(() => !!nowPlaying.value || route.value.startsWith('/listen'))

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

interface Downloaded { version: string; install(): Promise<void>; close(): Promise<void> }
let downloaded: Downloaded | null = null

async function checkApp(): Promise<U.CheckResult> {
  const online = isOnline()
  if (!appUpdates) return online ? { kind: 'none' } : { kind: 'failed', error: 'offline', online }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const u = await check({ timeout: 30_000 })
    if (!u) return { kind: 'current' }
    // download() checks the signature against the public key in tauri.conf.json and throws on a mismatch.
    // Each Update holds its downloaded bytes on the Rust side until close(), so only one stays open.
    if (downloaded?.version === u.version) await u.close().catch(() => {})
    else {
      try { await u.download() } catch (e) { await u.close().catch(() => {}); throw e }
      const earlier = downloaded
      downloaded = u
      await earlier?.close().catch(() => {})
    }
    return { kind: 'ready', version: u.version }
  } catch (error) {
    return { kind: 'failed', error, online: isOnline() }
  }
}

async function check(manual: boolean) {
  await readVersion()
  const before = installed.value
  const force = manual || U.forcePlugins(updates.value.lastVersion, version.value)
  const [app] = await Promise.all([checkApp(), checkUpdates(Date.now(), undefined, force).catch(() => [])])
  save({ ...U.afterCheck(updates.value, app, Date.now()), lastVersion: version.value })
  for (const name of U.newlyPending(before, installed.value)) notify(`${name} has an update that asks for new permissions. Allow it in Settings, Updates.`, 8000)
}

let running: Promise<void> | null = null
let queued: Promise<void> | null = null
/**
 * Check the app and every plugin now; one check at a time. `manual` is the Check now button: plugins
 * skip their 24 hours, and pressed during a launch check it runs again right after.
 */
export function runCheck(manual = false): Promise<void> {
  if (running) return manual ? (queued ??= running.catch(() => {}).then(() => { queued = null; return runCheck(true) })) : running
  running = check(manual).finally(() => { running = null })
  return running
}

/** At launch, a few seconds after the first screen, then whenever 24 hours have passed. */
export function startUpdates(delay = 8000) {
  setTimeout(() => {
    runCheck().catch(() => {})
    setInterval(() => { if (U.isDue(Date.now(), updates.value.lastCheck)) runCheck().catch(() => {}) }, HOUR)
  }, delay)
}

export async function restartToUpdate() {
  if (!downloaded || playing.value) return
  try {
    await downloaded.install()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (e) {
    notify(`The update did not install: ${(e as Error).message ?? e}`, 8000)
  }
}
