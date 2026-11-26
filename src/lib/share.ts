// Share this computer's library with the person's other devices (desktop only).
import { signal, effect } from '@preact/signals'
import { isDesktop, invoke } from './platform'
import { getFolders } from './library'
import { items, notify } from './store'
import { sync } from './sync/engine'

export interface ShareLink { label: string; url: string }
export interface ShareStatus {
  on: boolean
  local_url: string | null
  lan_urls: string[]
  tailscale_url: string | null
  tailscale_error: string | null
  setup_links: ShareLink[]
  code: string | null
}
export interface SharePrefs { on: boolean; lan: boolean; tailscale: boolean }

const KEY = 'flick.share'
const off: ShareStatus = { on: false, local_url: null, lan_urls: [], tailscale_url: null, tailscale_error: null, setup_links: [], code: null }

/** Per device, so it is kept apart from the synced settings. */
function loadPrefs(): SharePrefs {
  try { return { on: false, lan: false, tailscale: false, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return { on: false, lan: false, tailscale: false } }
}
export const sharePrefs = signal<SharePrefs>(loadPrefs())
export const shareStatus = signal<ShareStatus>(off)
export const shareBusy = signal(false)

/** The link to show first: Tailscale, then the LAN, then this computer. */
export function primaryLink(links: ShareLink[]): ShareLink | null {
  const rank = (l: ShareLink) => (l.label === 'Tailscale' ? 0 : l.label.startsWith('Wi-Fi') ? 1 : 2)
  return [...links].sort((a, b) => rank(a) - rank(b))[0] ?? null
}

/** True when the shared folders differ from the ones the running share uses. */
export function foldersChanged(running: string[] | null, now: string[]): boolean {
  if (!running) return false
  const a = [...new Set(running)].sort()
  const b = [...new Set(now)].sort()
  return a.length !== b.length || a.some((x, i) => x !== b[i])
}

let shared: string[] | null = null

async function folderPaths(): Promise<string[]> {
  return (await getFolders()).map((f) => f.path).filter((p): p is string => !!p)
}

/** Starts, restarts or stops sharing to match the saved switches. */
export async function applyShare(patch: Partial<SharePrefs> = {}) {
  if (!isDesktop) return
  const p = { ...sharePrefs.value, ...patch }
  sharePrefs.value = p
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* private mode */ }
  shareBusy.value = true
  try {
    if (!p.on) {
      await invoke('share_stop')
      shared = null
      shareStatus.value = off
      return
    }
    const folders = await folderPaths()
    shareStatus.value = await invoke<ShareStatus>('share_start', { folders, name: sync.value.name || null, lan: p.lan, tailscale: p.tailscale })
    shared = folders
  } catch (e) {
    notify(`Sharing: ${(e as Error).message ?? String(e)}`)
  } finally {
    shareBusy.value = false
  }
  // Folders added or removed while it was starting.
  if (shared && foldersChanged(shared, await folderPaths())) await applyShare()
}

/** A new access code. Every connected device must reconnect with the new link. */
export async function newShareCode() {
  await invoke('share_new_code')
  if (sharePrefs.value.on) await applyShare()
}

let started = false
/** On launch: share again when it was on, and restart when folders are added or removed. */
export function startShare() {
  if (!isDesktop || started) return
  started = true
  if (sharePrefs.value.on) applyShare()
  effect(() => {
    void items.value
    if (!shared || shareBusy.peek()) return
    folderPaths().then((now) => { if (foldersChanged(shared, now)) applyShare() })
  })
}
