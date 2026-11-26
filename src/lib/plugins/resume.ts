/** Where a plugin video's play position is saved. */
export const progressKey = (p: string, videoId: string) => `pl:${p}:${videoId}`

export interface Saved { pos: number; dur: number; at: number }
export interface VideoRef { id: string; season?: number; episode?: number }
/** Where to pick a title back up: `pos` seconds into `videoId`, or the start of the next episode. */
export interface Resume { videoId: string; pos: number; next: boolean }

/** The player picks up anything under 93% (store.play); under 10 seconds is not worth a Resume. */
export const unfinished = (s: Saved | undefined): s is Saved => !!s && s.dur > 0 && s.pos >= 10 && s.pos < s.dur * 0.93
const finished = (s: Saved) => s.dur > 0 && s.pos >= s.dur * 0.93

const order = (a: VideoRef, b: VideoRef) => ((a.season || 1e6) - (b.season || 1e6)) || ((a.episode ?? 0) - (b.episode ?? 0))

export function resumeOf(saved: Record<string, Saved>, plugin: string, id: string, videos: VideoRef[] = []): Resume | null {
  const list = videos.length ? videos : [{ id }]
  const last = list
    .map((v) => ({ v, s: saved[progressKey(plugin, v.id)] }))
    .filter((x): x is { v: VideoRef; s: Saved } => !!x.s)
    .sort((a, b) => b.s.at - a.s.at)[0]
  if (!last) return null
  if (unfinished(last.s)) return { videoId: last.v.id, pos: last.s.pos, next: false }
  if (!finished(last.s) || list.length < 2) return null
  const sorted = [...list].sort(order)
  const after = sorted[sorted.indexOf(last.v) + 1]
  return after ? { videoId: after.id, pos: 0, next: true } : null
}
