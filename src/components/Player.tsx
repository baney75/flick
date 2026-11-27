// The player. Full-window, keyboard-first, controls that get out of the way.

import { useEffect, useRef, useState, useCallback } from 'preact/hooks'
import { langCode } from '../lib/release'
import { nowPlaying, saveProgress, settings, setSettings, notify, type PlayRequest, type SubTrack, play } from '../lib/store'
import { resolve, storeFile, type Resolved } from '../lib/library'
import { formatTime } from '../lib/parse'
import { vttUrl, toVtt } from '../lib/subs'
import { isDesktop, isMobileApp, hasOpfs, invoke } from '../lib/platform'
import { kodiLive, urlLive } from '../lib/servers'
import { barFor, oneRetry, openToolStream, stopToolStream } from '../lib/plugins/runtime'
import { Icon } from './icons'
import { Readout } from './Readout'
import { Delayed, KEEPS_STALLING, kindOf, OPENING, waitLine, Watchdog } from '../lib/stalls'
import { note, sourceOf } from '../lib/playlog'
import { afterError, cardButtons, convertLine, followed, withServerFallback, DESKTOP_ONLY, isHls, planStream, playsHere, planSeek, probeStream, probes, Remux, SAFE, writtenOf, type Live, type StreamProbe, cuesAt, messageOf } from '../lib/playback'

const SPEEDS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

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
  // A stream the web view cannot open plays through a live remux run; its start offsets the clock.
  const remux = useRef<Remux | null>(null)
  const restarting = useRef(false)
  // A direct play the probe could not vouch for: the safe remux to switch to on a decode error.
  const fallback = useRef<Live | null>(null)
  const fbProbe = useRef<StreamProbe | null>(null)
  // What plays now, for a reload at the same place, and the watchdog over it (rule 6).
  const playingUrl = useRef('')
  const dog = useRef<Watchdog | null>(null)
  const [stallLine, setStallLine] = useState<string | null>(null)
  const [stuck, setStuck] = useState(false)
  const tool = useRef<{ url: string; retry: ReturnType<typeof oneRetry> } | null>(null)
  const [live, setLive] = useState(false)

  const [status, setStatus] = useState<string | null>(OPENING)
  // The words beside the spinner wait 1 s (rule 7); the spinner shows at once.
  const [words, setWords] = useState<string | null>(null)
  const delayed = useRef<Delayed | null>(null)
  if (!delayed.current) delayed.current = new Delayed(setWords)
  useEffect(() => { delayed.current!.set(status) }, [status])
  const [error, setError] = useState<string | null>(null)
  // The playback log's clock and state (SPEC-playback-2 rule 7).
  const began = useRef(0)
  const firstFrame = useRef(false)
  const stallFrom = useRef<{ t: number; ahead: number; seeking: boolean } | null>(null)
  /** How long the stall still open has lasted: one that never recovers is logged at the card or close. */
  const openStall = () => (stallFrom.current ? Date.now() - stallFrom.current.t : null)
  useEffect(() => { if (error) note('outcome', { result: 'error', message: error, stuck, stalledMs: openStall() }) }, [error])
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
    const closed = new AbortController()
    const v = video.current!
    let toolUrl: string | null = null
    ;(async () => {
      try {
        let url = req.url
        let liveIn: Live | undefined
        if (!url && req.src) {
          const r = await resolve(req.src, (s) => !cancelled && setStatus(s), req.ref.t === 'item' && !req.stream ? req.ref.id : undefined)
          if (cancelled) { r.revoke?.(); return }
          resolved.current = r
          url = r.url
          liveIn = r.live
          if (r.file) setFile(r.file)
          if (r.sidecarSubs?.length) {
            setSubs((s) => [...s, ...r.sidecarSubs!.map((x) => ({ label: x.name, url: vttUrl(x.name, x.text) }))])
            setSubOn(0)
          }
        }
        if (!url) throw new Error('Nothing to play.')
        began.current = Date.now()
        note('play_start', { kind: req.src?.t ?? (req.via ? 'debrid' : req.peers ? 'torrent' : 'url'), ref: req.ref.t, service: req.via?.service ?? null, ...sourceOf(url) })
        if (url.startsWith('flick-tool:')) {
          setStatus('Starting the stream')
          toolUrl = url
          // A close while this opens stops it in the app: an open that began before a close starts nothing.
          const got = await openToolStream(url)
          if (cancelled) return
          tool.current = { url, retry: oneRetry(openToolStream) }
          setLive(got.live)
          url = got.url
          setStatus(null)
        }
        let startAt = req.startAt
        // The website has no ffmpeg: a stream its browser cannot open says so before any fetch, with no spinner.
        if (!isDesktop && !playsHere(url, (t) => v.canPlayType(t))) {
          setStatus(null)
          setStuck(true)
          setError(DESKTOP_ONLY)
          return
        }
        // A link the desktop probes, or a source resolve() says needs the remux (a library MKV, a Kodi AVI).
        const input: Live | null = liveIn ?? (probes(url) ? { input: url, user: '', pass: '' } : null)
        if (input) {
          // One resolve (a 4xx, 5xx or 90 s of silence stops here), then the final URL plays as it is or
          // through the remux; a probe that fails never stops the play (SPEC-playback-2 rules 1 and 2).
          const planned = await planStream(input, !!liveIn, (line) => !cancelled && setStatus(line), closed.signal)
          if (cancelled || !planned) return
          const plan = req.fallbackUrl ? withServerFallback(planned) : planned
          if (plan !== planned) note('decision', { plan: 'direct', serverFallback: true })
          if ('direct' in plan) {
            url = plan.direct
            fallback.current = plan.fallback
            fbProbe.current = plan.probe ?? null
          } else {
            const local = await openLive(plan.remux, plan.probe, req.startAt ?? 0, plan.safe)
            if (cancelled || !local) return
            url = local
            startAt = 0
          }
        }
        await attach(v, url, startAt)
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
        if (preview.current && req.kind === 'video' && !isHls(url) && !req.peers) preview.current.src = url
      } catch (e) {
        if (!cancelled) { setStatus(null); setError(messageOf(e)) }
      }
    })()
    return () => {
      cancelled = true
      note('close', { played: began.current > 0 && firstFrame.current, at: Math.round(clock()), stalledMs: openStall() })
      closed.abort()
      remux.current?.stop()
      if (toolUrl) stopToolStream(toolUrl)
      dog.current?.stop()
      delayed.current?.stop()
      hls.current?.destroy()
      resolved.current?.revoke?.()
    }
  }, [])

  async function attach(v: HTMLVideoElement, url: string, startAt = req.startAt) {
    hls.current?.destroy()
    hls.current = null
    playingUrl.current = url
    // Through a ref: the watchdog outlives this render, and a reload must use the current speed and volume.
    if (!dog.current) dog.current = new Watchdog(kindOf(req, url, !!remux.current), { reload: () => onStuck.current.reload(), giveUp: () => onStuck.current.giveUp() })
    dog.current.attached()
    // A local event playlist (a flick-tool: stream through ffmpeg) is still growing; start at the top, not the live edge.
    const local = isHls(url) && /^(asset:|https?:\/\/asset\.localhost\/)/.test(url)
    if (isHls(url) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js')
      if (!Hls.isSupported()) throw new Error('This browser cannot play HLS streams.')
      const h = new Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, maxBufferLength: 60, startPosition: startAt || (local ? 0 : -1) }) as unknown as HlsLike
      h.on(Hls.Events.ERROR, (_e: unknown, d: { fatal: boolean; details: string }) => {
        if (d.fatal) onFail(`Stream error: ${d.details}`)
      })
      h.loadSource(url)
      h.attachMedia(v)
      hls.current = h
    } else {
      v.src = url
      // A growing playlist opens near its live edge, and WebKit overrides a seek made at loadedmetadata;
      // one made at the first canplay holds (measured in WebKit: 48 s in, then 0).
      if (local && !startAt) v.addEventListener('canplay', () => { if (v.currentTime > 1) v.currentTime = 0 }, { once: true })
    }
    v.playbackRate = speed
    v.volume = volume
    if (startAt) v.currentTime = startAt
    v.play().catch(() => setPlaying(false))
  }

  /** Starts the live remux of `input` at source time `at`; its playlist URL, or null when replaced. */
  function openLive(input: Live, p: StreamProbe, at: number, safe = false) {
    // A retry that switches to the remux is watched as a remux from here (the next attach builds it).
    dog.current?.stop()
    dog.current = null
    const r = new Remux(input.input, p, input.user, input.pass, invoke, safe)
    remux.current = r
    setDur(p.duration)
    setStatus(convertLine(p))
    const t = Date.now()
    const opened = r.open(at).then((u) => {
      if (u) note('run_start', { ms: Date.now() - t, at: Math.round(at), safe, convertsVideo: p.convertsVideo, convertsAudio: p.convertsAudio })
      return u
    }, (e) => {
      note('run_start', { ms: Date.now() - t, safe, error: messageOf(e) })
      throw e
    })
    // A safe run asks the warmed server once more for the length, for the seek bar and saved progress.
    if (!r.known) {
      probeStream(input.input, input.user, input.pass).then((q) => {
        if (remux.current === r && q.duration > 0) { r.length = q.duration; setDur(q.duration) }
      }).catch(() => {})
    }
    return opened
  }

  function onFail(msg: string, unsupported = false, code?: number) {
    const v = video.current!
    // A run being replaced loses its folder; the new run plays instead.
    if (restarting.current) return
    // No reload behind an error card or a conversion; a failed reload says the stream keeps stalling.
    if (dog.current?.failed()) return
    const r = remux.current
    const t = tool.current
    const step = afterError(code, r, t && (() => t.retry(t.url, v.currentTime || req.startAt || 0)), fallback.current)
    if (step?.to === 'transcode' && r) {
      // A run the web view cannot decode restarts once, at the same spot, with everything transcoded.
      r.transcode = true
      note('fallback', { to: 'transcode', code: code ?? null })
      restartAt(r, clock())
      return
    }
    if (step?.to === 'card') { setStatus(null); setError(msg); return }
    if (step?.to === 'lookup') {
      // A plugin stream's address expires and is bound to this IP: looked up again once, at the same spot.
      // A later decode error remuxes the new address.
      setStatus('Reconnecting')
      // Closed meanwhile: the close's stop already ended this open in the app.
      step.again.then(({ play, at }) => {
        if (video.current !== v) return
        req.startAt = at
        setLive(play.live)
        fallback.current = followed(fallback.current, play.url)
        return attach(v, play.url)
      }).catch((e) => { setStatus(null); setError((e as Error).message || msg) })
      return
    }
    // The web view cannot decode this stream: the remux at the same spot, the safe profile when the probe failed.
    if (step?.to === 'remux') {
      const fb = step.fb
      const p = fbProbe.current
      fallback.current = null
      note('fallback', { to: p ? 'remux' : 'safe profile', code: code ?? null })
      const at = v.currentTime || req.startAt || 0
      ;(async () => {
        const url = await openLive(fb, p ?? SAFE, at, !p)
        if (video.current !== v) { remux.current?.stop(); return }
        if (url) await attach(v, url, 0)
      })().catch((e) => { setStatus(null); setError(messageOf(e) || msg) })
      return
    }
    const src = req.src
    // A URL with a server-side fallback stream (Jellyfin, Plex) uses that instead.
    const convertible = src?.t === 'kodi' || (src?.t === 'url' && !src.fallback)
    if (unsupported && convertible && isDesktop && !isMobileApp && !triedConvert.current) {
      // The web view cannot decode this file (an MKV, or AC-3 or DTS audio in an MP4): stream it through
      // the live remux and pick up where it stopped.
      triedConvert.current = true
      const at = v.currentTime || req.startAt || 0
      setStatus(OPENING)
      ;(async () => {
        const input = src.t === 'kodi' ? await kodiLive(src) : await urlLive(src.url)
        const p = await probeStream(input.input, input.user, input.pass).catch(() => null)
        // A player closed meanwhile starts no run; one closed while the run starts stops it.
        if (video.current !== v) return
        const url = await openLive(input, p ?? SAFE, at, !p)
        if (video.current !== v) { remux.current?.stop(); return }
        if (url) await attach(v, url, 0)
      })().catch((e) => { setStatus(null); setError(messageOf(e) || msg) })
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
    let shown = ''
    const draw = () => {
      // A remux run's element clock starts at 0, so its lines are picked by the source's clock.
      const cues = (remux.current ? cuesAt(on?.cues, clock()) : Array.from(on?.activeCues ?? [])) as VTTCue[]
      const key = cues.map((c) => `${c.startTime}\n${c.text}`).join('\n\n')
      if (key === shown) return
      shown = key
      box.replaceChildren(...cues.map((c) => {
        const line = document.createElement('span')
        line.className = 'cue'
        line.append(c.getCueAsHTML())
        return line
      }))
    }
    draw()
    on?.addEventListener('cuechange', draw)
    v.addEventListener('timeupdate', draw)
    return () => { on?.removeEventListener('cuechange', draw); v.removeEventListener('timeupdate', draw); box.replaceChildren() }
  }, [subOn, subs.length])

  // ---- the source's clock: a remux run starts at r.at, so its clock is offset by that ----
  const clock = () => {
    const v = video.current
    if (!v) return 0
    return remux.current ? remux.current.time(v.currentTime) : v.currentTime
  }
  const durOf = () => {
    const v = video.current
    if (!v) return 0
    return remux.current ? remux.current.duration(v.duration) : v.duration
  }
  /** Every seek: in place, or for a remux run outside what it wrote, a new run there. */
  const seekTo = (t: number) => {
    const v = video.current!
    const r = remux.current
    if (!r) { v.currentTime = t; return }
    const d = durOf()
    const plan = planSeek(r.clamp(t, d), r.at, writtenOf(v.seekable))
    if ('local' in plan) { v.currentTime = plan.local; return }
    setTime(plan.restart)
    restartAt(r, plan.restart)
  }
  async function restartAt(r: Remux, at: number) {
    const v = video.current!
    restarting.current = true
    // A stall open before the seek ends with it; the new run is watched from its start, its first wait expected.
    dog.current?.attached()
    v.pause()
    v.removeAttribute('src')
    v.load()
    setStatus(convertLine(r.transcode ? SAFE : r.probe))
    try {
      const url = await r.open(at)
      if (!url || remux.current !== r) return
      restarting.current = false
      await attach(v, url, 0)
    } catch (e) {
      restarting.current = false
      if (dog.current?.failed()) return
      setStatus(null)
      setError(String((e as Error)?.message ?? e))
    }
  }

  // ---- the stall watchdog: one reload at the same place, then point to another source ----
  function reload() {
    const v = video.current
    if (!v) return
    const at = clock()
    if (remux.current) { restartAt(remux.current, at); return }
    attach(v, playingUrl.current, at).catch((e) => { setStatus(null); setError(String((e as Error)?.message ?? e)) })
  }
  function giveUp() {
    video.current?.pause()
    setStatus(null)
    setStuck(true)
    setError(KEEPS_STALLING)
  }
  const onStuck = useRef({ reload, giveUp })
  onStuck.current = { reload, giveUp }
  const bufferedAt = (v: HTMLVideoElement) => {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5 && v.currentTime <= v.buffered.end(i)) return [v.buffered.start(i), v.buffered.end(i)]
    }
    return [v.currentTime, v.currentTime]
  }
  const onWaiting = () => {
    const v = video.current
    if (!v || restarting.current) return
    setStatus(waitLine(dog.current?.kind ?? 'plugin'))
    const [from, to] = bufferedAt(v)
    if (firstFrame.current && !stallFrom.current) stallFrom.current = { t: Date.now(), ahead: to - v.currentTime, seeking: v.seeking }
    dog.current?.waiting(from, to, v.seeking)
    setStallLine(dog.current?.summary() ?? null)
  }
  const onPlayingNow = () => {
    setStatus(null)
    if (!firstFrame.current) {
      firstFrame.current = true
      note('first_frame', { ms: Date.now() - began.current })
    }
    const st = stallFrom.current
    if (st) {
      stallFrom.current = null
      note('stall', { ms: Date.now() - st.t, ahead: Math.round(st.ahead * 10) / 10, seeking: st.seeking })
    }
    dog.current?.playing()
    setStallLine(dog.current?.summary() ?? null)
  }

  // ---- progress saving ----
  const lastSave = useRef(0)
  const save = useCallback(() => {
    const v = video.current
    const d = durOf()
    // A safe run's length is not known yet: no progress until it is, so a title never looks finished.
    if (!v || !d || !isFinite(d) || restarting.current || remux.current?.known === false) return
    const pos = clock()
    saveProgress(req.key, { pos, dur: d, at: Date.now(), title: req.title, subtitle: req.subtitle, poster: req.poster, ref: req.ref })
    req.onSave?.(pos, d)
  }, [req])
  useEffect(() => () => save(), [save])

  // ---- media element events ----
  const onTime = () => {
    // A last timeupdate can arrive after the player closes.
    const v = video.current
    if (!v || restarting.current) return
    setTime(clock())
    if (v.buffered.length) setBuffered((remux.current?.at ?? 0) + v.buffered.end(v.buffered.length - 1))
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
    const r = remux.current
    seekTo(r && !r.known ? Math.max(0, clock() + d) : Math.max(0, Math.min((durOf() || 0) - 0.1, clock() + d)))
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
          if (/^[0-9]$/.test(e.key) && durOf()) { seekTo((Number(e.key) / 10) * durOf()); flash(`${Number(e.key) * 10}%`) }
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
    set('seekto', (d) => { if (video.current && d.seekTime != null) seekTo(d.seekTime) })
    return () => { for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack', 'seekto'] as MediaSessionAction[]) set(a, null) }
  }, [req])

  // ---- scrubbing ----
  const bar = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragTo = useRef(0)
  const posFromEvent = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left))
    return { x, t: (x / r.width) * (dur || 0) }
  }
  const onBarDown = (e: PointerEvent) => {
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = posFromEvent(e)
    dragTo.current = p.t
    // A remux run restarts only where the drag ends, not at every step of it.
    if (!remux.current) video.current!.currentTime = p.t
    setTime(p.t)
  }
  const lastPreview = useRef(0)
  const onBarMove = (e: PointerEvent) => {
    const p = posFromEvent(e)
    setHover(p)
    if (dragging.current) {
      dragTo.current = p.t
      if (!remux.current) video.current!.currentTime = p.t
      setTime(p.t)
    }
    const pv = preview.current
    if (pv && pv.src && Date.now() - lastPreview.current > 120) {
      lastPreview.current = Date.now()
      pv.currentTime = p.t
    }
  }
  const onBarUp = () => {
    if (dragging.current && remux.current) seekTo(dragTo.current)
    dragging.current = false
  }

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

  const bar_ = barFor(live)
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
        onPause={() => { setPlaying(false); dog.current?.paused(); save() }}
        onWaiting={onWaiting}
        onPlaying={onPlayingNow}
        onProgress={() => { const v = video.current; if (v) dog.current?.data(bufferedAt(v)[1]) }}
        onCanPlay={() => setStatus(null)}
        onLoadedMetadata={() => setDur(durOf())}
        onDurationChange={() => setDur(durOf())}
        onTimeUpdate={onTime}
        onEnded={onEnded}
        onError={() => {
          const err = video.current?.error
          note('media_error', { code: err?.code ?? null, message: err?.message || null })
          const hint = isDesktop ? '' : ' Formats like MKV with AC3 or HEVC play best in the Flick desktop app.'
          onFail(err?.code === 4 ? `This file's format is not supported here.${hint}` : `Playback failed (${err?.message || 'unknown error'}).`, err?.code === 4, err?.code)
        }}
      >
        {subs.map((s, i) => <track key={s.url} kind="subtitles" label={s.label} srcLang={s.lang} src={s.url} default={i === subOn} />)}
      </video>
      <video ref={preview} class="preview-src" muted preload="auto" playsInline />
      <div ref={cueBox} class="subs" aria-live="off" />

      {status && !error && <div class="status"><span class="spinner" />{words}</div>}
      {error && (
        <div class="error-card">
          <h3>Can't play this</h3>
          <p>{error}</p>
          <div class="row">
            {cardButtons(req, stuck).map((b, _i, all) => b === 'open'
              ? <a class="btn" href={req.url} target="_blank" rel="noreferrer">Open stream URL</a>
              : b === 'back'
                ? <button class={`btn${all.includes('another') ? '' : ' primary'}`} onClick={close}>Back</button>
                : <button class="btn primary" onClick={() => { close(); setTimeout(() => document.querySelector<HTMLElement>('.streams .stream')?.focus(), 0) }}>Try another source</button>)}
          </div>
        </div>
      )}
      {osd && <div class="osd" key={osd.n}>{osd.text}</div>}

      <div class="top-bar">
        <button class="icon-btn" onClick={close} aria-label="Close player (Esc)"><Icon name="left" size={24} /></button>
        <div class="titles">
          <div class="t1">{req.title}</div>
          {req.subtitle && <div class="t2">{req.subtitle}</div>}
          <Readout video={video} via={req.via} url={req.url} stalls={stallLine} />
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
        {bar_.seek && <div class="scrub" ref={bar} onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerLeave={() => setHover(null)}
          role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(time)} tabIndex={0}>
          <div class="track"><div class="buf" style={{ width: `${bpct}%` }} /><div class="fill" style={{ width: `${pct}%` }} /><div class="knob" style={{ left: `${pct}%` }} /></div>
          {hover && dur > 0 && (
            <div class="hover-tip" style={{ left: `${hover.x}px` }}>
              {!audio && preview.current?.src && <PreviewFrame src={preview.current} />}
              <span>{formatTime(hover.t)}</span>
            </div>
          )}
        </div>}
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
          {bar_.label ? <div class="time live">{bar_.label}</div> : <div class="time">{formatTime(time)} <span>/ {formatTime(dur)}</span></div>}
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
