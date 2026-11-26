import { useEffect, useState } from 'preact/hooks'
import { route, go, toast, nowPlaying, settings, reloadItems, loadProgress, notify } from './lib/store'
import { Home } from './views/Home'
import { Library, ShowPage } from './views/Library'
import { Servers } from './views/Servers'
import { Settings } from './views/Settings'
import { PairPage } from './views/Sync'
import { startSyncBinding } from './lib/sync/bind'
import { Setup } from './views/Setup'
import { Reader } from './views/Reader'
import { Listen } from './views/Listen'
import { Player } from './components/Player'
import { Icon } from './components/icons'
import { Logo } from './components/Logo'
import { playFiles, playPaths } from './lib/actions'
import { isDesktop, invoke, onDesktopEvent } from './lib/platform'
import { kindOf } from './lib/parse'
import { installSpatialNav } from './lib/spatial'
import { resumeDownloads } from './lib/downloads'
import { startOffline } from './lib/offline'
import { startShare } from './lib/share'
import { PluginPage, PluginTitle, PluginIcon } from './views/Plugin'
import { sources, themes, startPlugins } from './lib/plugins/use'
import { applyTheme } from './lib/plugins/themes'
import { migrateStremio } from './lib/plugins/migrate'
import type { BookLink } from './views/Reader'

function bookLink(qs: URLSearchParams): BookLink | undefined {
  try {
    const ref = JSON.parse(qs.get('r') ?? '')
    const url = qs.get('u') ?? ''
    if (ref?.t !== 'plugin' || !/^https?:\/\//.test(url)) return undefined
    return { url, title: qs.get('t') ?? 'Book', key: `pl:${ref.p}:${ref.videoId}`, ref }
  } catch { return undefined }
}

const NAV = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/library', label: 'Library', icon: 'library' },
  { path: '/servers', label: 'Servers', icon: 'server' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]

function View() {
  const r = route.value
  const [path, query] = r.split('?')
  const parts = path.split('/').filter(Boolean)
  const qs = new URLSearchParams(query ?? '')
  if (parts[0] === 'library') return <Library />
  if (parts[0] === 'read' && parts[1]) return <Reader key={parts[1]} id={decodeURIComponent(parts[1])} />
  if (parts[0] === 'read-url' && bookLink(qs)) return <Reader key={r} id="" link={bookLink(qs)} />
  if (parts[0] === 'p' && parts[1] && parts[3]) return <PluginTitle key={r} p={decodeURIComponent(parts[1])} type={parts[2]} id={decodeURIComponent(parts[3])} videoId={qs.get('v') ?? undefined} />
  if (parts[0] === 'p' && parts[1]) return <PluginPage key={parts[1]} id={decodeURIComponent(parts[1])} />
  if (parts[0] === 'listen' && parts[1]) return <Listen key={parts[1]} id={decodeURIComponent(parts[1])} />
  if (parts[0] === 'show' && parts[1]) return <ShowPage name={decodeURIComponent(parts[1])} />
  if (parts[0] === 'servers') return <Servers />
  if (parts[0] === 'settings') return <Settings />
  if (parts[0] === 'pair') return <PairPage k={qs.get('k')} />
  if (parts[0] === 'setup') return <Setup key={r} code={qs.get('c') ?? ''} />
  return <Home />
}

export function App() {
  const [drag, setDrag] = useState(false)
  const theme = settings.value.theme
  const current = '/' + (route.value.split('?')[0].split('/').filter(Boolean)[0] ?? '')

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme
  }, [theme])

  const look = settings.value.look
  const lookTheme = themes.value.find((t) => t.id === look)
  useEffect(() => {
    try { applyTheme(lookTheme ?? null) } catch { applyTheme(null) }
  }, [lookTheme])

  useEffect(() => {
    installSpatialNav(() => !!nowPlaying.value)
    // Plugins load first so the one-time Stremio move can see them, then progress loads already moved.
    startPlugins().then(() => migrateStremio()).catch(() => {})
      .finally(() => { Promise.all([reloadItems(), loadProgress()]).then(startSyncBinding).catch(() => {}).then(startShare) })
    resumeDownloads().catch(() => {})
    startOffline()
    addEventListener('flick:db-stale', () => notify('Flick was updated in another tab. Reload this tab to keep going.', 15000))
    addEventListener('flick:db-blocked', () => notify('Close your other Flick tabs to finish updating.', 15000))
    if (isDesktop) {
      // Files opened from Finder before or after launch.
      invoke<string[]>('take_opened').then((p) => p.length && playPaths(p)).catch(() => {})
      const off = onDesktopEvent<string[]>('open-files', (p) => playPaths(p))
      return () => { off.then((f) => f()) }
    }
    // Website launched as an installed app with "Open with" (File Handling API).
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue
    lq?.setConsumer(async (p) => {
      if (!p.files?.length) return
      playFiles(await Promise.all(p.files.map((h) => h.getFile())))
    })
  }, [])

  // Drop files anywhere to play them.
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files') && !nowPlaying.value) { depth++; setDrag(true) } }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDrag(false) }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDrag(false)
      if (nowPlaying.value) return
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => kindOf(f.name))
      if (files.length) playFiles(files)
      else if (e.dataTransfer?.files.length) notify('Drop a video or audio file to play it.')
    }
    addEventListener('dragenter', enter)
    addEventListener('dragleave', leave)
    addEventListener('dragover', over)
    addEventListener('drop', drop)
    return () => {
      removeEventListener('dragenter', enter)
      removeEventListener('dragleave', leave)
      removeEventListener('dragover', over)
      removeEventListener('drop', drop)
    }
  }, [])

  return (
    <div class={`app ${isDesktop ? 'desktop' : ''}`}>
      {isDesktop && <div class="drag-strip" data-tauri-drag-region />}
      <nav class="sidebar" aria-label="Main">
        <a class="brand" href="#/" aria-label="Flick home"><Logo size={30} /><span class="brand-name">Flick</span></a>
        {NAV.map((n) => (
          <a href={`#${n.path}`} class={`nav-item ${current === n.path ? 'on' : ''}`} aria-current={current === n.path ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); go(n.path) }}>
            <Icon name={n.icon} size={20} /><span>{n.label}</span>
          </a>
        ))}
        {sources.value.map((p) => {
          const path = `/p/${encodeURIComponent(p.id)}`
          const on = route.value.split('?')[0] === path || route.value.startsWith(path + '/')
          return (
            <a href={`#${path}`} class={`nav-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(path) }}>
              <PluginIcon rec={p} size={20} /><span>{p.manifest.name}</span>
            </a>
          )
        })}
      </nav>
      <main class="main" id="main">
        <View />
      </main>
      <Player />
      {drag && <div class="dropzone"><div><Icon name="play" size={40} /><p>Drop to play</p></div></div>}
      {toast.value && <div class="toast" role="status" key={toast.value.id}>{toast.value.text}</div>}
    </div>
  )
}
