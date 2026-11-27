// The player. Full-window, keyboard-first, controls that get out of the way.

import { useEffect, useRef, useState, useCallback } from 'preact/hooks'
import { langCode } from '../lib/release'
import { nowPlaying, saveProgress, settings, setSettings, notify, type PlayRequest, type SubTrack, play } from '../lib/store'
import { resolve, storeFile, type Resolved } from '../lib/library'
import { formatTime } from '../lib/parse'
import { vttUrl, toVtt } from '../lib/subs'
import { isDesktop, isMobileApp, hasOpfs, invoke } from '../lib/platform'
import { kodiConvert, convertUrl } from '../lib/servers'
import { openToolStream } from '../lib/plugins/runtime'
import { Icon } from './icons'
import { Readout } from './Readout'

const SPEEDS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

function isHls(url: string) {
  return /\.m3u8(\?|$)/i.test(url) || /\/hlsv2\//.test(url)
}

type HlsLike = { destroy(): void; loadSource(u: string): void; attachMedia(v: HTMLMediaElement): void; on(e: string, cb: (...a: any[]) => void): void }

interface LoadedSub { label: string; url: string; lang?: string }

export function Player() {
  const req = nowPlaying.value
  if (!req) return null
  return <PlayerInner key={req.key + (req.url ?? '')} req={req} />
}

function PlayerInner({ req }: { req: PlayRequest }) {
  const shell = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const preview = useRef<HTMLVideoElement>(null)
  const hls = useRef<HlsLike | null>(null)
  const resolved = useRef<Resolved | null>(null)
  const triedFallback = useRef(false)
  const triedConvert = useRef(false)

  const [status, setStatus] = useState<string | null>('Loading')
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(settings.value.volume)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(settings.value.speed)
  const [idle, setIdle] = useState(false)
  const [full, setFull] = useState(false)
  const [menu, setMenu] = useState<null | 'speed' | 'subs' | 'help'>(null)
  const [subs, setSubs] = useState<LoadedSub[]>([])
  const [subOn, setSubOn] = useState(-1)
  const [osd, setOsd] = useState<{ text: string; n: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [upNext, setUpNext] = useState<{ req: PlayRequest; left: number } | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [storing, setStoring] = useState<number | null>(null)

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    nowPlaying.value = null
  }, [])

  const flash = (text: string) => setOsd({ text, n: Date.now() })
  useEffect(() => {
    if (!osd) return
    const t = setTimeout(() => setOsd(null), 700)
    return () => clearTimeout(t)
  }, [osd])

  // ---- load the source ----
  useEffect(() => {
    let cancelled = false
    const v = video.current!
    ;(async () => {
      try {
        let url = req.url
        if (!url && req.src) {
          const r = await resolve(req.src, (s) => !cancelled && setStatus(s), req.ref.t === 'item' && !req.stream ? req.ref.id : undefined)
          if (cancelled) { r.revoke?.(); return }
          resolved.current = r
          url = r.url
          if (r.file) setFile(r.file)
          if (r.sidecarSubs?.length) {
            setSubs((s) => [...s, ...r.sidecarSubs!.map((x) => ({ label: x.name, url: vttUrl(x.name, x.text) }))])
            setSubOn(0)
          }
        }
        if (!url) throw new Error('Nothing to play.')
        if (url.startsWith('flick-tool:')) {
          setStatus('Starting the stream')
          url = await openToolStream(url)
          if (cancelled) return
          setStatus(null)
        }
        await attach(v, url)
        if (isDesktop && req.src?.t === 'path') {
          // Subtitles inside MKV and MP4 files arrive after playback starts, so they never delay it.
          invoke<{ name: string; text: string }[]>('embedded_subs', { path: req.src.path }).then((list) => {
            if (cancelled || !list.length) return
            setSubs((s) => {
              if (!s.length) setSubOn(0)
              return [...s, ...list.map((x) => ({ label: x.name.replace(/\.vtt$/, ''), url: vttUrl(x.name, x.text) }))]
            })
          }).catch(() => {})
        }
        if (preview.current && req.kind === 'video' && !isHls(url)) preview.current.src = url
      } catch (e) {
        if (!cancelled) { setStatus(null); setError((e as Error).message) }
      }
    })()
    return () => {
      cancelled = true
      hls.current?.destroy()
      resolved.current?.revoke?.()
    }
  }, [])

  async function attach(v: HTMLVideoElement, url: string) {
    hls.current?.destroy()
    hls.current = null
    // A local event playlist (a flick-tool: stream through ffmpeg) is still growing; start at the top, not the live edge.
    const local = isHls(url) && /^(asset:|https?:\/\/asset\.localhost\/)/.test(url)
    if (isHls(url) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js')
      if (!Hls.isSupported()) throw new Error('This browser cannot play HLS streams.')
      const h = new Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, maxBufferLength: 60, startPosition: local ? 0 : -1 }) as unknown as HlsLike
      h.on(Hls.Events.ERROR, (_e: unknown, d: { fatal: boolean; details: string }) => {
        if (d.fatal) onFail(`Stream error: ${d.details}`)
      })
      h.loadSource(url)
      h.attachMedia(v)
      hls.current = h
    } else {
      v.src = url
      if (local && !req.startAt) v.addEventListener('loadedmetadata', () => { v.currentTime = 0 }, { once: true })
    }
    v.playbackRate = speed
    v.volume = volume
    if (req.startAt) v.currentTime = req.startAt
    v.play().catch(() => setPlaying(false))
  }

  function onFail(msg: string, unsupported = false) {
    const v = video.current!
    const src = req.src
    // A URL with a server-side fallback stream (Jellyfin, Plex) uses that instead.
    const convertible = src?.t === 'kodi' || (src?.t === 'url' && !src.fallback)
    if (unsupported && convertible && isDesktop && !isMobileApp && !triedConvert.current) {
      // The web view cannot decode this file (an MKV, or AC-3 or DTS audio in an MP4): convert it and pick up where it stopped.
      triedConvert.current = true
      const at = v.currentTime
      setStatus('Converting for playback')
      ;(src.t === 'kodi' ? kodiConvert(src, setStatus) : convertUrl(src.url, setStatus))
        .then((url) => { req.startAt = at || req.startAt; return attach(v, url) })
        .catch((e) => { setStatus(null); setError((e as Error).message || msg) })
      return
    }
    if (req.fallbackUrl && !triedFallback.current) {
      triedFallback.current = true
      setStatus('Switching to a compatible stream')
      const at = v.currentTime
      req.startAt = at || req.startAt
      attach(v, req.fallbackUrl).catch((e) => setError((e as Error).message))
      return
    }
    setStatus(null)
    setError(msg)
  }

  // ---- remote subtitles (plugins, servers): fetch and convert to VTT ----
  useEffect(() => {
    if (!req.subs?.length) return
    let cancelled = false
    ;(async () => {
      const out: LoadedSub[] = []
      for (const s of req.subs!.slice(0, 12)) {
        try {
          const text = await fetch(s.url).then((r) => r.text())
          out.push({ label: s.label, lang: s.lang, url: vttUrl(s.url.split('?')[0], text) })
        } catch { /* skip blocked subtitle hosts */ }
      }
      if (!cancelled && out.length) {
        setSubs((s) => {
          // The audio is not one the user listed: turn on the subtitle the pick chose (SPEC-best-stream rule 9).
          const at = req.subLang ? out.findIndex((x) => langCode(x.lang) === req.subLang) : -1
          if (at >= 0) setSubOn(s.length + at)
          return [...s, ...out]
        })
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Show the chosen subtitle track in our own box, not the browser's cue layer, so
  // the lines rise above the controls when they show instead of hiding under them.
  const cueBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const v = video.current
    const box = cueBox.current
    if (!v || !box) return
    const tracks = v.textTracks
    let on = null as TextTrack | null
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === subOn ? 'hidden' : 'disabled'
      if (i === subOn) on = tracks[i]
    }
    const draw = () => {
      const lines: Node[] = []
      const cues = on?.activeCues
      for (let i = 0; cues && i < cues.length; i++) {
        const line = document.createElement('span')
        line.className = 'cue'
        line.append((cues[i] as VTTCue).getCueAsHTML())
        lines.push(line)
      }
      box.replaceChildren(...lines)
    }
    draw()
    on?.addEventListener('cuechange', draw)
    return () => { on?.removeEventListener('cuechange', draw); box.replaceChildren() }
  }, [subOn, subs.length])

  // ---- progress saving ----
  const lastSave = useRef(0)
  const save = useCallback(() => {
    const v = video.current
    if (!v || !v.duration || !isFinite(v.duration)) return
    saveProgress(req.key, { pos: v.currentTime, dur: v.duration, at: Date.now(), title: req.title, subtitle: req.subtitle, poster: req.poster, ref: req.ref })
    req.onSave?.(v.currentTime, v.duration)
  }, [req])
  useEffect(() => () => save(), [save])

  // ---- media element events ----
  const onTime = () => {
    // A last timeupdate can arrive after the player closes.
    const v = video.current
    if (!v) return
    setTime(v.currentTime)
    if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1))
    if (Date.now() - lastSave.current > 5000) { lastSave.current = Date.now(); save() }
  }

  const onEnded = () => {
    save()
    const next = req.next?.()
    if (next && settings.value.autoplayNext) setUpNext({ req: next, left: 6 })
    else setPlaying(false)
  }

  useEffect(() => {
    if (!upNext) return
    if (upNext.left <= 0) { play(upNext.req); return }
    const t = setTimeout(() => setUpNext((u) => (u ? { ...u, left: u.left - 1 } : u)), 1000)
    return () => clearTimeout(t)
  }, [upNext])

  // ---- controls ----
  const toggle = () => {
    const v = video.current!
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }
  const seekBy = (d: number) => {
    const v = video.current!
    v.currentTime = Math.max(0, Math.min((v.duration || 0) - 0.1, v.currentTime + d))
    flash(`${d > 0 ? '+' : '−'}${Math.abs(d)}s`)
  }
  const setVol = (x: number) => {
    const v = video.current!
    x = Math.max(0, Math.min(1, x))
    v.volume = x
    v.muted = false
    setVolume(x)
    setMuted(false)
    setSettings({ volume: x })
    flash(`Volume ${Math.round(x * 100)}%`)
  }
  const setRate = (x: number) => {
    video.current!.playbackRate = x
    setSpeed(x)
    setSettings({ speed: x })
    flash(`${x}×`)
  }
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else shell.current?.requestFullscreen().catch(() => {})
  }
  const togglePip = async () => {
    const v = video.current!
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await v.requestPictureInPicture()
    } catch { notify('Picture in picture is not available here.') }
  }
  const step = (dir: number) => {
    const v = video.current!
    v.pause()
    v.currentTime = Math.max(0, v.currentTime + dir / 30)
  }
  const goNext = () => {
    const n = req.next?.()
    if (n) { save(); play(n) }
  }

  const addSubFile = async (f: File) => {
    const text = await f.text()
    const url = URL.createObjectURL(new Blob([toVtt(f.name, text)], { type: 'text/vtt' }))
    setSubs((s) => {
      setSubOn(s.length)
      return [...s, { label: f.name, url }]
    })
    flash('Subtitles on')
  }

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ---- auto-hide controls ----
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wake = () => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), 2400)
  }
  useEffect(() => { wake(); return () => clearTimeout(idleTimer.current) }, [])

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Enter' && (e.target as HTMLElement).closest('button, label')) return
      const v = video.current!
      const skip = settings.value.skipSeconds
      let handled = true
      switch (e.key) {
        case ' ': case 'k': case 'K': case 'Enter': case 'MediaPlayPause': toggle(); break
        case 'MediaFastForward': seekBy(30); break
        case 'MediaRewind': seekBy(-30); break
        case 'GoBack': case 'BrowserBack': close(); break
        case 'ArrowLeft': seekBy(e.shiftKey ? -30 : -5); break
        case 'ArrowRight': seekBy(e.shiftKey ? 30 : 5); break
        case 'j': case 'J': seekBy(-skip); break
        case 'l': case 'L': seekBy(skip); break
        case 'ArrowUp': setVol(v.volume + 0.05); break
        case 'ArrowDown': setVol(v.volume - 0.05); break
        case 'm': case 'M': v.muted = !v.muted; setMuted(v.muted); flash(v.muted ? 'Muted' : 'Sound on'); break
        case 'f': case 'F': toggleFull(); break
        case 'p': case 'P': togglePip(); break
        case 'c': case 'C':
          if (subs.length) { setSubOn((i) => (i >= 0 ? -1 : 0)); flash(subOn >= 0 ? 'Subtitles off' : 'Subtitles on') }
          else flash('No subtitles. Drop a .srt file here.')
          break
        case ']': case '>': setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(nearest(speed)) + 1)]); break
        case '[': case '<': setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(nearest(speed)) - 1)]); break
        case '\\': setRate(1); break
        case ',': step(-1); break
        case '.': step(1); break
        case 'n': case 'N': goNext(); break
        case '?': setMenu((m) => (m === 'help' ? null : 'help')); break
        case 'Escape':
          if (menu) setMenu(null)
          else if (document.fullscreenElement) document.exitFullscreen()
          else close()
          break
        default:
          if (/^[0-9]$/.test(e.key) && v.duration) { v.currentTime = (Number(e.key) / 10) * v.duration; flash(`${Number(e.key) * 10}%`) }
          else handled = false
      }
      if (handled) { e.preventDefault(); wake() }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  // ---- Media Session: hardware media keys and the system Now Playing widget ----
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: req.subtitle ? `${req.title} · ${req.subtitle}` : req.title,
      artist: 'Flick',
      artwork: req.poster ? [{ src: req.poster, sizes: '512x512' }] : [],
    })
    const ms = navigator.mediaSession
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h) } catch { /* unsupported */ } }
    set('play', () => video.current?.play())
    set('pause', () => video.current?.pause())
    set('seekbackward', () => seekBy(-settings.value.skipSeconds))
    set('seekforward', () => seekBy(settings.value.skipSeconds))
    set('nexttrack', req.next ? goNext : null)
    set('seekto', (d) => { if (video.current && d.seekTime != null) video.current.currentTime = d.seekTime })
    return () => { for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack', 'seekto'] as MediaSessionAction[]) set(a, null) }
  }, [req])

  // ---- scrubbing ----
  const bar = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const posFromEvent = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left))
    return { x, t: (x / r.width) * (dur || 0) }
  }
  const onBarDown = (e: PointerEvent) => {
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = posFromEvent(e)
    video.current!.currentTime = p.t
    setTime(p.t)
  }
  const lastPreview = useRef(0)
  const onBarMove = (e: PointerEvent) => {
    const p = posFromEvent(e)
    setHover(p)
    if (dragging.current) { video.current!.currentTime = p.t; setTime(p.t) }
    const pv = preview.current
    if (pv && pv.src && Date.now() - lastPreview.current > 120) {
      lastPreview.current = Date.now()
      pv.currentTime = p.t
    }
  }
  const onBarUp = () => { dragging.current = false }

  // ---- drag and drop subtitles onto the player ----
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer?.files?.[0]
    if (f && /\.(srt|vtt|ass|ssa)$/i.test(f.name)) addSubFile(f)
  }

  const store = async () => {
    if (!file) return
    setStoring(0)
    try {
      await storeFile(file, (p) => setStoring(p))
      notify('Stored in your Flick library.')
    } catch (e) {
      notify(`Could not store it: ${(e as Error).message}`)
    }
    setStoring(null)
  }

  const pct = dur ? (time / dur) * 100 : 0
  const bpct = dur ? (buffered / dur) * 100 : 0
  const showControls = !idle || !playing || menu !== null
  const audio = req.kind === 'audio'

  return (
    <div ref={shell} class={`player ${showControls ? '' : 'idle'}`} onPointerMove={wake} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      role="dialog" aria-label={`Playing ${req.title}`}>
      {audio && (
        <div class="audio-stage">
          {req.poster ? <img src={req.poster} alt="" /> : <div class="audio-art"><Icon name="music" size={72} /></div>}
          <h2>{req.title}</h2>
          {req.subtitle && <p>{req.subtitle}</p>}
        </div>
      )}
      <video
        ref={video}
        class={audio ? 'hidden-video' : ''}
        playsInline
        poster={!audio ? req.poster : undefined}
        onClick={toggle}
        onDblClick={toggleFull}
        onPlay={() => { setPlaying(true); setStatus(null) }}
        onPause={() => { setPlaying(false); save() }}
        onWaiting={() => setStatus('Buffering')}
        onPlaying={() => setStatus(null)}
        onCanPlay={() => setStatus(null)}
        onLoadedMetadata={(e) => setDur((e.currentTarget as HTMLVideoElement).duration)}
        onDurationChange={(e) => setDur((e.currentTarget as HTMLVideoElement).duration)}
        onTimeUpdate={onTime}
        onEnded={onEnded}
        onError={() => {
          const err = video.current?.error
          const hint = isDesktop ? '' : ' Formats like MKV with AC3 or HEVC play best in the Flick desktop app.'
          onFail(err?.code === 4 ? `This file's format is not supported here.${hint}` : `Playback failed (${err?.message || 'unknown error'}).`, err?.code === 4)
        }}
      >
        {subs.map((s, i) => <track key={s.url} kind="subtitles" label={s.label} srcLang={s.lang} src={s.url} default={i === subOn} />)}
      </video>
      <video ref={preview} class="preview-src" muted preload="auto" playsInline />
      <div ref={cueBox} class="subs" aria-live="off" />

      {status && !error && <div class="status"><span class="spinner" />{status}</div>}
      {error && (
        <div class="error-card">
          <h3>Can't play this</h3>
          <p>{error}</p>
          <div class="row">
            {req.url && <a class="btn" href={req.url} target="_blank" rel="noreferrer">Open stream URL</a>}
            <button class="btn primary" onClick={close}>Back</button>
          </div>
        </div>
      )}
      {osd && <div class="osd" key={osd.n}>{osd.text}</div>}

      <div class="top-bar">
        <button class="icon-btn" onClick={close} aria-label="Close player (Esc)"><Icon name="left" size={24} /></button>
        <div class="titles">
          <div class="t1">{req.title}</div>
          {req.subtitle && <div class="t2">{req.subtitle}</div>}
          <Readout video={video} via={req.via} url={req.url} />
        </div>
        {file && hasOpfs && req.src?.t === 'session' && (
          <button class="btn ghost" onClick={store} disabled={storing !== null}>
            <Icon name="download" size={16} /> {storing !== null ? `Storing ${Math.round(storing * 100)}%` : 'Keep in library'}
          </button>
        )}
        <button class="icon-btn" onClick={() => setMenu(menu === 'help' ? null : 'help')} aria-label="Keyboard shortcuts (?)"><Icon name="keyboard" /></button>
      </div>

      {upNext && (
        <div class="up-next">
          <div class="small">Up next in {upNext.left}</div>
          <div class="t1">{upNext.req.subtitle ?? upNext.req.title}</div>
          <div class="row">
            <button class="btn primary" onClick={() => play(upNext.req)}>Play now</button>
            <button class="btn ghost" onClick={() => setUpNext(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div class="bottom-bar">
        <div class="scrub" ref={bar} onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerLeave={() => setHover(null)}
          role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(time)} tabIndex={0}>
          <div class="track"><div class="buf" style={{ width: `${bpct}%` }} /><div class="fill" style={{ width: `${pct}%` }} /><div class="knob" style={{ left: `${pct}%` }} /></div>
          {hover && dur > 0 && (
            <div class="hover-tip" style={{ left: `${hover.x}px` }}>
              {!audio && preview.current?.src && <PreviewFrame src={preview.current} />}
              <span>{formatTime(hover.t)}</span>
            </div>
          )}
        </div>
        <div class="controls">
          <button class="icon-btn big" onClick={toggle} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}><Icon name={playing ? 'pause' : 'play'} size={28} /></button>
          <button class="icon-btn" onClick={() => seekBy(-settings.value.skipSeconds)} aria-label="Back 10 seconds (J)"><Icon name="back10" /></button>
          <button class="icon-btn" onClick={() => seekBy(settings.value.skipSeconds)} aria-label="Forward 10 seconds (L)"><Icon name="fwd10" /></button>
          {req.next && <button class="icon-btn" onClick={goNext} aria-label="Next episode (N)"><Icon name="next" /></button>}
          <div class="vol">
            <button class="icon-btn" onClick={() => { const v = video.current!; v.muted = !v.muted; setMuted(v.muted) }} aria-label="Mute (M)">
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
            </button>
            <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onInput={(e) => setVol(Number((e.target as HTMLInputElement).value))} aria-label="Volume" />
          </div>
          <div class="time">{formatTime(time)} <span>/ {formatTime(dur)}</span></div>
          <div class="spacer" />
          <div class="menu-wrap">
            <button class={`icon-btn label ${speed !== 1 ? 'on' : ''}`} onClick={() => setMenu(menu === 'speed' ? null : 'speed')} aria-label="Speed">{speed}×</button>
            {menu === 'speed' && (
              <div class="pop">
                {SPEEDS.map((s) => <button class={s === speed ? 'on' : ''} onClick={() => { setRate(s); setMenu(null) }}>{s}×</button>)}
              </div>
            )}
          </div>
          <div class="menu-wrap">
            <button class={`icon-btn ${subOn >= 0 ? 'on' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles (C)"><Icon name="cc" /></button>
            {menu === 'subs' && (
              <div class="pop wide">
                <button class={subOn < 0 ? 'on' : ''} onClick={() => { setSubOn(-1); setMenu(null) }}>Off</button>
                {subs.map((s, i) => <button class={i === subOn ? 'on' : ''} onClick={() => { setSubOn(i); setMenu(null) }}>{s.label}</button>)}
                <label class="file-btn">Load subtitle file…<input type="file" accept=".srt,.vtt,.ass,.ssa" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) addSubFile(f); setMenu(null) }} /></label>
              </div>
            )}
          </div>
          {!audio && 'pictureInPictureEnabled' in document && <button class="icon-btn" onClick={togglePip} aria-label="Picture in picture (P)"><Icon name="pip" /></button>}
          <button class="icon-btn" onClick={toggleFull} aria-label="Full screen (F)"><Icon name={full ? 'unfull' : 'full'} /></button>
        </div>
      </div>

      {menu === 'help' && <Shortcuts onClose={() => setMenu(null)} />}
    </div>
  )
}

function nearest(x: number) {
  return SPEEDS.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a))
}

/** Paints the hidden preview video's current frame into a small canvas. */
function PreviewFrame({ src }: { src: HTMLVideoElement }) {
  const c = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const draw = () => {
      const cv = c.current
      if (!cv || !src.videoWidth) return
      cv.getContext('2d')!.drawImage(src, 0, 0, cv.width, cv.height)
    }
    draw()
    src.addEventListener('seeked', draw)
    return () => src.removeEventListener('seeked', draw)
  }, [src])
  return <canvas ref={c} width={192} height={108} />
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Space / K', 'Play or pause'], ['← →', 'Back or forward 5s (Shift: 30s)'], ['J / L', 'Back or forward 10s'],
    ['↑ ↓', 'Volume'], ['M', 'Mute'], ['F / double-click', 'Full screen'], ['P', 'Picture in picture'],
    ['C', 'Subtitles on or off'], ['[ ]', 'Slower or faster'], ['\\', 'Normal speed'], [', .', 'Frame back or forward'],
    ['0 to 9', 'Jump to 0% to 90%'], ['N', 'Next episode'], ['Esc', 'Close'],
  ]
  return (
    <div class="help" onClick={onClose}>
      <div class="help-card" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard</h3>
        <dl>{rows.map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}</dl>
        <p class="small">Drop a .srt, .vtt or .ass file on the video to add subtitles.</p>
      </div>
    </div>
  )
}

export type { SubTrack }
