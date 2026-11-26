// The audiobook player: chapters, a sleep timer, speed kept per book, and the place kept across every part.

import { useEffect, useRef, useState } from 'preact/hooks'
import { items, loaded, saveProgress, go, thumbTick, settings, type Progress } from '../lib/store'
import * as db from '../lib/db'
import { resolve, saveItems, thumbUrl, type Item } from '../lib/library'
import { formatTime } from '../lib/parse'
import { isDesktop, invoke } from '../lib/platform'
import { mp4Info, id3Cover, sniff, bookChapters, blobRead, urlRead, chapterAt, startSleep, sleepDue, bookSpeed, setBookSpeed, type Chapter, type Sleep } from '../lib/audiobook'
import { Icon } from '../components/icons'

const SPEEDS = [0.75, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2, 2.5, 3]
const SLEEPS: (number | 'chapter')[] = [15, 30, 45, 60, 'chapter']

const measure = (url: string) => new Promise<number>((done) => {
  const a = new Audio()
  a.preload = 'metadata'
  a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0)
  a.onerror = () => done(0)
  a.src = url
})

export function Listen({ id }: { id: string }) {
  const it = items.value.find((i) => i.id === id)
  if (!it) return loaded.value ? <div class="page"><p class="dim">This audiobook is not in your library.</p><a href="#/library">Back to library</a></div> : <div class="listen"><span class="spinner" aria-label="Opening" /></div>
  return <Book it={it} />
}

function Book({ it }: { it: Item }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [parts, setParts] = useState<{ url: string; dur: number }[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [part, setPart] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [sleep, setSleep] = useState<Sleep>(null)
  const [menu, setMenu] = useState<null | 'chapters' | 'sleep' | 'speed'>(null)
  const [cover, setCover] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>('Loading')
  const pending = useRef<number | null>(null)
  const resume = useRef(false)
  const lastSave = useRef(0)

  const offsets = parts.reduce<number[]>((o, p, i) => [...o, o[i] + p.dur], [0])
  const total = offsets[parts.length] ?? 0

  useEffect(() => {
    let live = true
    const revokes: (() => void)[] = []
    ;(async () => {
      try {
        const list = it.parts ?? [{ src: it.src, title: it.title }]
        const urls = await Promise.all(list.map(async (p, i) => {
          const r = await resolve(p.src, (s) => live && setStatus(s), list.length === 1 ? it.id : undefined)
          if (r.revoke) revokes.push(r.revoke)
          // One file needs no measuring: its length arrives with its metadata.
          return { url: r.url, file: r.file, dur: list[i].dur ?? (list.length > 1 ? await measure(r.url) : 0) }
        }))
        if (!live) return
        // Keep measured part lengths, so the next open needs no measuring.
        if (it.parts && it.parts.some((p, i) => p.dur !== urls[i].dur)) saveItems([{ ...it, parts: it.parts.map((p, i) => ({ ...p, dur: urls[i].dur })) }]).catch(() => {})
        // Chapters inside each file: ffprobe on desktop (M4B, MP3 with ID3 chapters, MKA, Ogg), and the MP4
        // boxes of a one-file book anywhere. Files without any become one chapter each.
        const inner: Chapter[][] = list.map(() => [])
        if (isDesktop) await Promise.all(list.map(async (p, i) => {
          if (p.src.t === 'path') inner[i] = await invoke<Chapter[]>('chapters', { path: p.src.path }).catch(() => [])
        }))
        // Cover art (and web chapters) come from the first file's bytes, recognized by content, not by name.
        let art: Uint8Array | undefined
        const [read, size] = urls[0].file ? [blobRead(urls[0].file), urls[0].file.size] as const : await urlRead(urls[0].url).catch(() => [null, 0] as const)
        const kind = read ? sniff(await read(0, 12).catch(() => new Uint8Array())) : null
        if (read && kind === 'mp4') {
          const info = await mp4Info(read, size).catch(() => ({ chapters: [], cover: undefined }))
          if (list.length === 1 && !inner[0].length) inner[0] = info.chapters
          art = info.cover
        } else if (read && kind === 'id3') art = await id3Cover(read).catch(() => undefined)
        const ch = bookChapters(list.map((p, i) => ({ title: p.title, dur: urls[i].dur })), inner)
        if (art && !(await thumbUrl(it.id))) { await db.put('thumbs', it.id, new Blob([art as BlobPart], { type: art[0] === 0x89 ? 'image/png' : 'image/jpeg' })); thumbTick.value++ }
        const [saved, sp, img] = await Promise.all([db.get<Progress>('progress', it.id).catch(() => undefined), bookSpeed(it.id, settings.value.speed), thumbUrl(it.id)])
        if (!live) return
        // Start in the part that holds the saved place. A finished book starts over.
        const at = saved && (!saved.dur || saved.pos < saved.dur - 2) ? saved.pos : 0
        let p = 0
        for (let o = 0; p < urls.length - 1 && o + urls[p].dur <= at; p++) o += urls[p].dur
        pending.current = at
        setSpeed(sp)
        setCover(it.poster ?? img)
        setChapters(ch.length ? ch : [{ title: it.title, start: 0 }])
        setPart(p)
        setParts(urls.map((u) => ({ url: u.url, dur: u.dur })))
        setStatus(null)
      } catch (e) {
        if (live) setStatus((e as Error).message || 'This audiobook could not be opened.')
      }
    })()
    return () => { live = false; revokes.forEach((r) => r()) }
  }, [it.id])

  const save = () => {
    if (!total) return
    saveProgress(it.id, { pos: t, dur: total, book: true, at: Date.now(), title: it.title, subtitle: it.author, ref: { t: 'item', id: it.id } }).catch(() => {})
  }

  // Seek anywhere in the book: switch parts when the time is in another file.
  const seek = (g: number) => {
    g = Math.max(0, Math.min(total - 0.5, g))
    const p = Math.max(0, offsets.findLastIndex((o, i) => i < parts.length && o <= g))
    if (p !== part) { pending.current = g; resume.current = !audio.current?.paused; setPart(p) }
    else if (audio.current) audio.current.currentTime = g - offsets[p]
    setT(g)
  }

  const onMeta = () => {
    const a = audio.current!
    a.playbackRate = speed
    if (!parts[part].dur && isFinite(a.duration)) setParts(parts.map((x, i) => (i === part ? { ...x, dur: a.duration } : x)))
    if (pending.current != null) { a.currentTime = Math.max(0, pending.current - offsets[part]); setT(pending.current); pending.current = null }
    if (resume.current) { resume.current = false; a.play().catch(() => {}) }
  }
  const onTime = () => {
    const a = audio.current
    if (!a) return
    const g = offsets[part] + a.currentTime
    setT(g)
    if (sleepDue(sleep, Date.now(), g)) { a.pause(); setSleep(null) }
    if (Date.now() - lastSave.current > 5000) { lastSave.current = Date.now(); save() }
  }
  const onEnded = () => {
    if (part < parts.length - 1) { pending.current = offsets[part + 1]; resume.current = true; setPart(part + 1) } else { setPlaying(false); save() }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => () => saveRef.current(), [])
  // Wall-clock timers fire even while paused between timeupdates.
  useEffect(() => {
    if (!sleep || !('until' in sleep)) return
    const k = setTimeout(() => { audio.current?.pause(); setSleep(null) }, sleep.until - Date.now())
    return () => clearTimeout(k)
  }, [sleep])

  const toggle = () => { const a = audio.current; if (a) a.paused ? a.play().catch(() => {}) : a.pause() }
  const cur = chapterAt(chapters, t)
  const prevChapter = () => seek(t - chapters[cur].start > 3 || cur === 0 ? chapters[cur].start : chapters[cur - 1].start)
  const nextChapter = () => { if (chapters[cur + 1]) seek(chapters[cur + 1].start) }
  const rate = (s: number) => { setSpeed(s); if (audio.current) audio.current.playbackRate = s; setBookSpeed(it.id, s).catch(() => {}); setMenu(null) }
  const leave = () => { save(); history.length > 1 ? history.back() : go('/library') }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select') || e.metaKey || e.ctrlKey) return
      const act: Record<string, () => void> = { ' ': toggle, k: toggle, ArrowLeft: () => seek(t - 30), ArrowRight: () => seek(t + 30), Escape: () => (menu ? setMenu(null) : leave()) }
      if (act[e.key]) { e.preventDefault(); act[e.key]() }
    }
    addEventListener('keydown', k)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: it.author ?? '', artwork: cover ? [{ src: cover }] : [] })
      const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => { try { navigator.mediaSession.setActionHandler(a, h) } catch { /* unsupported */ } }
      set('seekbackward', () => seek(t - 30))
      set('seekforward', () => seek(t + 30))
      set('previoustrack', prevChapter)
      set('nexttrack', nextChapter)
    }
    return () => removeEventListener('keydown', k)
  })

  const chEnd = chapters[cur + 1]?.start ?? total
  const sleepLabel = !sleep ? 'Sleep' : 'at' in sleep ? 'End of chapter' : `${Math.ceil((sleep.until - Date.now()) / 60000)} min`
  return (
    <div class="listen" onClick={() => menu && setMenu(null)}>
      <header class="reader-bar">
        <button class="btn ghost sm" onClick={leave} aria-label="Back"><Icon name="left" size={18} /></button>
        <div class="reader-title"><div class="t1">{it.title}</div>{it.author && <div class="t2">{it.author}</div>}</div>
      </header>
      <div class="listen-body">
        {cover ? <img class="listen-cover" src={cover} alt="" /> : <div class="listen-cover art-ph"><Icon name="book" size={64} /></div>}
        {status ? <p class="dim">{status === 'Loading' ? <span class="spinner" aria-label="Loading" /> : status}</p> : (
          <>
            <div class="listen-chapter">{chapters[cur]?.title}</div>
            <input class="listen-scrub" type="range" min={0} max={total} step={1} value={t} aria-label="Position" onInput={(e) => seek(Number((e.target as HTMLInputElement).value))} />
            <div class="listen-times small dim"><span>{formatTime(t - chapters[cur].start)}</span><span>-{formatTime(chEnd - t)} in chapter</span><span>{formatTime(total - t)} left</span></div>
            <div class="listen-controls">
              <button class="icon-btn" onClick={prevChapter} aria-label="Previous chapter"><Icon name="left" /></button>
              <button class="icon-btn" onClick={() => seek(t - 30)} aria-label="Back 30 seconds"><Icon name="back10" /><span class="tiny">30</span></button>
              <button class="icon-btn big" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={30} /></button>
              <button class="icon-btn" onClick={() => seek(t + 30)} aria-label="Forward 30 seconds"><Icon name="fwd10" /><span class="tiny">30</span></button>
              <button class="icon-btn" onClick={nextChapter} disabled={!chapters[cur + 1]} aria-label="Next chapter"><Icon name="next" /></button>
            </div>
            <div class="listen-menus" onClick={(e) => e.stopPropagation()}>
              <button class="btn sm" onClick={() => setMenu(menu === 'chapters' ? null : 'chapters')} aria-expanded={menu === 'chapters'}>Chapters ({chapters.length})</button>
              <button class={`btn sm ${sleep ? 'primary' : ''}`} onClick={() => setMenu(menu === 'sleep' ? null : 'sleep')} aria-expanded={menu === 'sleep'}>{sleepLabel}</button>
              <button class="btn sm" onClick={() => setMenu(menu === 'speed' ? null : 'speed')} aria-label="Speed">{speed}×</button>
              {menu && (
                <div class="pop listen-pop" role="menu">
                  {menu === 'chapters' && chapters.map((c, i) => <button class={i === cur ? 'on' : ''} onClick={() => { seek(c.start); setMenu(null) }}>{c.title}<span class="dim">{formatTime(c.start)}</span></button>)}
                  {menu === 'sleep' && [...SLEEPS.map((s) => <button onClick={() => { setSleep(startSleep(s, Date.now(), t, chapters, total)); setMenu(null) }}>{s === 'chapter' ? 'End of chapter' : `${s} minutes`}</button>),
                    sleep && <button onClick={() => { setSleep(null); setMenu(null) }}>Turn off</button>]}
                  {menu === 'speed' && SPEEDS.map((s) => <button class={s === speed ? 'on' : ''} onClick={() => rate(s)}>{s}×</button>)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {parts[part] && (
        <audio ref={audio} src={parts[part].url} preload="auto" onLoadedMetadata={onMeta} onTimeUpdate={onTime} onEnded={onEnded}
          onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); if (!resume.current) save() }} />
      )}
    </div>
  )
}
