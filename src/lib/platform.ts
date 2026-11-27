// Bridges to the Tauri desktop shell. On the website every call here is a no-op or null.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
// The Tauri shell on a phone, tablet or TV: no ffmpeg there. iPadOS reports a Mac, so check for touch too.
export const isMobileApp =
  isDesktop && (/Android|iPhone|iPad/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
// A phone: the phone app, or a phone's browser.
export const isPhone = isMobileApp || (typeof navigator !== 'undefined' && /Android.+Mobile|iPhone/i.test(navigator.userAgent))
// Safari's engine (the Mac and iPhone apps, Safari itself) plays no OGG or Opus files.
export const isApple = typeof navigator !== 'undefined' && /Macintosh|iPhone|iPad/.test(navigator.userAgent)
export const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window
export const hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory

export interface ScanEntry { path: string; name: string; size: number; mtime: number }
export interface Probe { duration: number; container: string; video?: string; audio?: string; playable: boolean }

async function core() {
  return import('@tauri-apps/api/core')
}

export interface InvokeRow { cmd: string; start: number; end: number; ok: boolean }
/** Every invoke in a self-test run (window.__FLICK_SELFTEST__, set only by the self-test build or harness). */
export const invokeLog: InvokeRow[] = []
const logInvokes = typeof window !== 'undefined' && '__FLICK_SELFTEST__' in window

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!logInvokes) return (await core()).invoke<T>(cmd, args)
  const start = performance.now()
  let ok = false
  try {
    const v = await (await core()).invoke<T>(cmd, args)
    ok = true
    return v
  } finally {
    if (invokeLog.length < 5000) invokeLog.push({ cmd, start, end: performance.now(), ok })
  }
}

let convert: ((p: string) => string) | null = null
export async function fileUrl(path: string): Promise<string> {
  if (!convert) convert = (await core()).convertFileSrc
  return convert(path)
}

/** A URL for a custom shell protocol, in the form this platform's web view uses. */
export async function protocolUrl(path: string, protocol: string): Promise<string> {
  return (await core()).convertFileSrc(path, protocol)
}

export async function pickFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const r = await open({ directory: true, multiple: false, title: 'Add a media folder' })
  return typeof r === 'string' ? r : null
}

export async function pickFiles(): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const r = await open({
    multiple: true,
    title: 'Open media',
    filters: [{ name: 'Media', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'ts', 'mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac'] }],
  })
  if (!r) return []
  return Array.isArray(r) ? r : [r]
}

/** Every display's size in device pixels, attached monitors included; undefined when the shell cannot say. */
export async function displaySizes(): Promise<{ width: number; height: number }[] | undefined> {
  try {
    const { availableMonitors } = await import('@tauri-apps/api/window')
    const list = await availableMonitors()
    return list.length ? list.map((m) => ({ width: m.size.width, height: m.size.height })) : undefined
  } catch {
    return undefined // the window's own screen still gives a size
  }
}

export async function onDesktopEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(name, (e) => cb(e.payload))
}
