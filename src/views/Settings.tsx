import { useEffect, useState } from 'preact/hooks'
import { settings, setSettings, notify, items, stremio, go } from '../lib/store'
import { isDesktop, invoke } from '../lib/platform'
import { formatBytes } from '../lib/parse'
import { SyncPanel } from './Sync'
import { Icon } from '../components/icons'
import { downloads, removeDownload } from '../lib/downloads'
import { currentSetup, encodeSetup, validateSetup, SETUP_BASE } from '../lib/setup'
import { PluginsPanel, ThemePicker } from './Plugins'

async function shareSetup() {
  const link = SETUP_BASE + encodeSetup(await currentSetup(stremio.value.addons.map((a) => a.transportUrl)))
  try {
    await navigator.clipboard.writeText(link)
    notify('Setup link copied. It holds your server tokens: send it only to people you trust.', 6000)
  } catch {
    prompt('Copy this setup link:', link)
  }
}

function importSetup() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    try { go('/setup?c=' + encodeSetup(validateSetup(JSON.parse(await f.text())))) } catch (e) { notify(`Setup file: ${(e as Error).message}`) }
  }
  input.click()
}

export function Settings() {
  const s = settings.value
  const [usage, setUsage] = useState<{ usage?: number; quota?: number } | null>(null)
  const [ff, setFf] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    navigator.storage?.estimate?.().then(setUsage).catch(() => {})
    if (isDesktop) invoke<{ ffmpeg: string | null }>('ffmpeg_status').then((r) => setFf(r.ffmpeg)).catch(() => setFf(null))
  }, [])

  const makeDefault = async () => {
    try {
      const r = await invoke<string>('make_default_player')
      notify(r)
    } catch (e) {
      notify((e as Error).message ?? String(e))
    }
  }

  return (
    <div class="page narrow">
      <header class="page-head"><h1>Settings</h1></header>

      <section class="panel">
        <h3>Playback</h3>
        <label class="toggle"><input type="checkbox" checked={s.autoplayNext} onChange={(e) => setSettings({ autoplayNext: (e.target as HTMLInputElement).checked })} /> Play the next episode on its own</label>
        <label>Skip buttons jump
          <select value={s.skipSeconds} onChange={(e) => setSettings({ skipSeconds: Number((e.target as HTMLSelectElement).value) })}>
            {[5, 10, 15, 30].map((n) => <option value={n}>{n} seconds</option>)}
          </select>
        </label>
        <label>Default speed
          <select value={s.speed} onChange={(e) => setSettings({ speed: Number((e.target as HTMLSelectElement).value) })}>
            {[0.75, 1, 1.25, 1.5, 2].map((n) => <option value={n}>{n}×</option>)}
          </select>
        </label>
      </section>

      <SyncPanel />

      <section class="panel">
        <h3>Appearance</h3>
        <label>Mode
          <select value={s.theme} onChange={(e) => setSettings({ theme: (e.target as HTMLSelectElement).value as 'system' })}>
            <option value="system">Match the system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <ThemePicker />
      </section>

      <PluginsPanel />

      {isDesktop && (
        <section class="panel">
          <h3>Mac</h3>
          <p class="dim small">Make Flick open videos and music when you double-click them in Finder, instead of QuickTime.</p>
          <button class="btn primary" onClick={makeDefault}>Make Flick the default player</button>
          <p class="small dim">
            {ff === undefined ? 'Checking for ffmpeg…' : ff ? `MKV, AVI and other formats convert through ffmpeg at ${ff}.` : 'ffmpeg not found. MP4, MOV and M4V play; install ffmpeg (brew install ffmpeg) to also play MKV and AVI.'}
          </p>
        </section>
      )}

      <section class="panel">
        <h3>Setup</h3>
        <p class="dim small">Share your addons, servers and settings with one link, or import a setup file someone made for you. You review everything before it connects.</p>
        <p class="err">The link contains your server tokens. Anyone who has it can use your servers, so send it only to people you trust.</p>
        <div class="row">
          <button class="btn" onClick={shareSetup}><Icon name="link" size={16} /> Share my setup</button>
          <button class="btn" onClick={importSetup}><Icon name="file" size={16} /> Import setup file</button>
        </div>
      </section>

      <Downloads />

      <section class="panel">
        <h3>Storage</h3>
        <p class="dim small">{items.value.length} items in your library.{usage?.usage != null ? ` Flick uses ${formatBytes(usage.usage)}${usage.quota ? ` of ${formatBytes(usage.quota)} available` : ''} on this device.` : ''}</p>
      </section>

      <section class="panel">
        <h3>Privacy</h3>
        <p class="dim small">Your library, history and sign-in keys stay on this device. Flick has no account, no analytics and no ads. It only talks to the services you connect: Stremio and its addons, and your own servers. Sync goes through a relay that forwards sealed messages it cannot read and stores nothing.</p>
      </section>
    </div>
  )
}

function Downloads() {
  const s = settings.value
  const rows = [...downloads.value.values()]
  const done = rows.filter((d) => d.state === 'done')
  const active = rows.filter((d) => d.state === 'queued' || d.state === 'downloading')
  const [space, setSpace] = useState<{ used: number; free: number | null } | null>(null)
  useEffect(() => {
    if (isDesktop) invoke<{ used: number; free: number | null }>('downloads_space').then(setSpace).catch(() => {})
    else setSpace({ used: done.reduce((n, d) => n + d.total, 0), free: null })
  }, [done.length])
  const clear = async () => {
    if (!confirm(`Remove all ${done.length + active.length} downloads from this device? Your servers keep their files.`)) return
    for (const d of rows) await removeDownload(d.id).catch(() => {})
    notify('Downloads removed.')
  }
  return (
    <section class="panel">
      <h3>Downloads</h3>
      <p class="dim small">
        {done.length ? `${done.length} saved for offline` : 'Nothing saved yet. Open an item\'s menu, or a show, and choose Download.'}
        {active.length ? ` · ${active.length} downloading` : ''}
        {space && space.used ? ` · ${formatBytes(space.used)} used` : ''}
        {space?.free != null ? ` · ${formatBytes(space.free)} free` : ''}
      </p>
      <label class="toggle"><input type="checkbox" checked={s.removeWatched} onChange={(e) => setSettings({ removeWatched: (e.target as HTMLInputElement).checked })} /> Remove a download after I watch it</label>
      {rows.length > 0 && <button class="btn ghost sm" onClick={clear}>Remove all downloads</button>}
    </section>
  )
}
