import { useEffect, useState } from 'preact/hooks'
import { settings, setSettings, notify, items } from '../lib/store'
import { isDesktop, invoke } from '../lib/platform'
import { formatBytes } from '../lib/parse'
import { SyncPanel } from './Sync'

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
        <label>Theme
          <select value={s.theme} onChange={(e) => setSettings({ theme: (e.target as HTMLSelectElement).value as 'system' })}>
            <option value="system">Match the system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </section>

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
