// Bridges to the Tauri desktop shell. On the website every call here is a no-op or null.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window
export const hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory

export interface ScanEntry { path: string; name: string; size: number; mtime: number }
export interface Probe { duration: number; container: string; video?: string; audio?: string; playable: boolean }

async function core() {
  return import('@tauri-apps/api/core')
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const c = await core()
  return c.invoke<T>(cmd, args)
}

let convert: ((p: string) => string) | null = null
export async function fileUrl(path: string): Promise<string> {
  if (!convert) convert = (await core()).convertFileSrc
  return convert(path)
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

export async function onDesktopEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(name, (e) => cb(e.payload))
}
