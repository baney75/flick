import { useEffect, useState } from 'preact/hooks'
import { route, go, toast, nowPlaying, settings, reloadItems, loadProgress, loadStremio, notify } from './lib/store'
import { Home } from './views/Home'
import { Library, ShowPage } from './views/Library'
import { Stremio, StremioDetail } from './views/Stremio'
import { Servers } from './views/Servers'
import { Settings } from './views/Settings'
import { Player } from './components/Player'
import { Icon } from './components/icons'
import { playFiles, playPaths } from './lib/actions'
import { isDesktop, invoke, onDesktopEvent } from './lib/platform'
import { kindOf } from './lib/parse'
import { installSpatialNav } from './lib/spatial'

const NAV = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/library', label: 'Library', icon: 'library' },
  { path: '/stremio', label: 'Stremio', icon: 'stremio' },
  { path: '/servers', label: 'Servers', icon: 'server' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]

function View() {
  const r = route.value
  const [path, query] = r.split('?')
  const parts = path.split('/').filter(Boolean)
  const qs = new URLSearchParams(query ?? '')
  if (parts[0] === 'library') return <Library />
  if (parts[0] === 'show' && parts[1]) return <ShowPage name={decodeURIComponent(parts[1])} />
  if (parts[0] === 'stremio' && parts[2]) return <StremioDetail key={r} type={parts[1]} id={decodeURIComponent(parts[2])} videoId={qs.get('v') ?? undefined} />
  if (parts[0] === 'stremio') return <Stremio />
  if (parts[0] === 'servers') return <Servers />
  if (parts[0] === 'settings') return <Settings />
  return <Home />
}

export function App() {
  const [drag, setDrag] = useState(false)
  const theme = settings.value.theme
  const current = '/' + (route.value.split('?')[0].split('/').filter(Boolean)[0] ?? '')

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme
  }, [theme])

  useEffect(() => {
    installSpatialNav(() => !!nowPlaying.value)
    reloadItems()
    loadProgress()
    loadStremio()
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
        <a class="brand" href="#/" aria-label="Flick home"><span class="brand-mark"><Icon name="play" size={14} /></span><span class="brand-name">Flick</span></a>
        {NAV.map((n) => (
          <a href={`#${n.path}`} class={`nav-item ${current === n.path ? 'on' : ''}`} aria-current={current === n.path ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); go(n.path) }}>
            <Icon name={n.icon} size={20} /><span>{n.label}</span>
          </a>
        ))}
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
