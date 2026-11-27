// The playback log (SPEC-playback-2 rules 7 and 8). The player notes each step of a play; the desktop
// scrubs every string (a URL keeps its host and file type, a path its type) and appends one JSON line to
// ~/Library/Logs/com.dbaney.flick/playback.log. The website keeps no log. Nothing is sent anywhere.

import { invoke, isDesktop } from './platform'

export type Fields = Record<string, string | number | boolean | null | undefined | string[]>
export type Note = (event: string, fields?: Fields) => void

/** A source as the log names it: its host and file type, never its path, query or login. */
export function sourceOf(url: string): { host: string; ext: string } {
  try {
    const u = new URL(url)
    const ext = /\.([a-z0-9]{1,5})$/i.exec(u.pathname)?.[1]?.toLowerCase() ?? ''
    return { host: u.protocol === 'file:' ? '' : u.host, ext }
  } catch {
    return { host: '', ext: /\.([a-z0-9]{1,5})$/i.exec(url)?.[1]?.toLowerCase() ?? '' }
  }
}

/** Appends one event; a failure to log never touches playback. */
export const note: Note = (event, fields = {}) => {
  if (!isDesktop) return
  invoke('playback_log', { event, fields }).catch(() => {})
}

/** The last 200 lines, for Settings to copy. Empty on the website. */
export function logTail(): Promise<string> {
  return isDesktop ? invoke<string>('playback_log_tail').catch(() => '') : Promise.resolve('')
}
