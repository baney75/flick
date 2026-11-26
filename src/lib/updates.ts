// When Flick checks for updates and what it shows afterward. Pure: no Tauri, no timers, no storage,
// so every rule here has a test.

export const DAY = 24 * 60 * 60 * 1000

export interface UpdateState {
  /** When the last check finished, ok or not (ms). 0 before the first one. */
  lastCheck: number
  /** The app version that ran last time, so official plugins refresh when the app changes. */
  lastVersion: string
  /** A downloaded update waiting for Restart. Never saved: a restart without installing drops it. */
  ready: string | null
  /** One line for the Updates panel. Never a toast. */
  status: string
}

export const initial: UpdateState = { lastCheck: 0, lastVersion: '', ready: null, status: '' }

export type CheckResult =
  | { kind: 'current' }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; error: unknown; online: boolean }
  /** This build has no app updater (the website, phones). Only plugins were checked. */
  | { kind: 'none' }

/** The desktop apps update themselves; the website reloads and phones use their stores. */
export const updaterEnabled = (desktop: boolean, mobile: boolean) => desktop && !mobile

/**
 * A check is due at launch (the caller runs one) and then once 24 hours have passed since the last.
 * A last check in the future (the clock was set ahead, then fixed) is due now.
 */
export const isDue = (now: number, lastCheck: number) => now < lastCheck || now - lastCheck >= DAY

export function isOffline(error: unknown, online: boolean): boolean {
  if (!online) return true
  const msg = error instanceof Error ? error.message : String(error)
  return /network|dns|resolve|connect|offline|timed? ?out|failed to fetch|error sending request/i.test(msg)
}

export function afterCheck(s: UpdateState, r: CheckResult, now: number): UpdateState {
  const next = { ...s, lastCheck: now }
  switch (r.kind) {
    case 'ready': return { ...next, ready: r.version, status: `Flick ${r.version} is downloaded.` }
    case 'current': return { ...next, status: 'Flick is up to date.' }
    case 'none': return { ...next, status: '' }
    case 'failed': {
      // Offline or a refused download: keep running this version and try again in 24 hours.
      if (isOffline(r.error, r.online)) return { ...next, status: 'Could not reach GitHub. Flick tries again in 24 hours.' }
      const msg = r.error instanceof Error ? r.error.message : String(r.error)
      return { ...next, status: `The update check failed: ${msg}` }
    }
  }
}

/** The banner waits while anything plays, so nothing interrupts a video. */
export const showBanner = (ready: string | null, playing: boolean) => !!ready && !playing

export const bannerText = (version: string) => `Flick ${version} is ready. Restart to update.`

/**
 * Official plugins come from the app's own /plugins/ folder, so they change only when the app does.
 * The first launch of a new version checks them at once instead of waiting out their 24 hours.
 */
export const forcePlugins = (lastVersion: string, current: string) => lastVersion !== current

/** Plugins whose update newly waits for the user to allow new permissions. */
export function newlyPending<T extends { id: string; pending?: unknown; manifest: { name: string } }>(before: T[], after: T[]): string[] {
  const had = new Set(before.filter((p) => p.pending).map((p) => p.id))
  return after.filter((p) => p.pending && !had.has(p.id)).map((p) => p.manifest.name)
}
