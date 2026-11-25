import { useEffect, useMemo, useState } from 'preact/hooks'
import { go } from '../lib/store'
import { fetchManifest } from '../lib/stremio'
import { isDesktop } from '../lib/platform'
import { decodeSetup, applySetup, describeSettings, type Setup as Payload, type SetupResult } from '../lib/setup'
import { Icon } from '../components/icons'

function preview(p: Payload, names: Record<string, string>): string[] {
  return [
    ...(p.stremioAddons ?? []).map((u) => `Stremio addon: ${names[u] ?? u}`),
    ...(p.servers ?? []).map((s) => `${s.type === 'plex' ? 'Plex' : 'Jellyfin'} server${s.name ? ` "${s.name}"` : ''} at ${s.url}`),
    ...(p.folders ?? []).map((f) => `Folder ${f}${isDesktop ? '' : ' (desktop app only, will be skipped here)'}`),
    ...(p.settings ? [`Settings: ${describeSettings(p.settings)}`] : []),
  ]
}

export function Setup({ code }: { code: string }) {
  const parsed = useMemo(() => {
    try { return { p: decodeSetup(code) } } catch (e) { return { err: (e as Error).message } }
  }, [code])
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<SetupResult[] | null>(null)

  useEffect(() => {
    for (const u of parsed.p?.stremioAddons ?? []) {
      fetchManifest(u).then((a) => setNames((n) => ({ ...n, [u]: a.manifest.name }))).catch(() => setNames((n) => ({ ...n, [u]: `${u} (not answering)` })))
    }
  }, [parsed])

  const connect = async () => {
    if (!parsed.p) return
    setBusy(true)
    setResults(await applySetup(parsed.p))
    setBusy(false)
  }

  const lines = parsed.p ? preview(parsed.p, names) : []
  return (
    <div class="page narrow">
      <header class="page-head"><h1>Set up Flick</h1></header>
      {parsed.err && <div class="panel"><p class="err">{parsed.err}</p><button class="btn" onClick={() => go('/')}>Go home</button></div>}
      {parsed.p && !results && (
        <div class="panel">
          <h3>{lines.length ? 'Someone shared a setup with you. Flick will add:' : 'This setup is empty.'}</h3>
          {lines.map((l) => <div class="list-row"><Icon name="plus" size={16} /><div class="grow">{l}</div></div>)}
          <p class="small dim">Only connect a setup from someone you trust. Nothing changes until you tap Connect all.</p>
          <div class="row">
            <button class="btn primary" onClick={connect} disabled={busy || !lines.length}>{busy ? 'Connecting…' : 'Connect all'}</button>
            <button class="btn ghost" onClick={() => go('/')} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      {results && (
        <div class="panel">
          <h3>Done</h3>
          {results.map((r) => (
            <div class="list-row">
              <Icon name={r.ok ? 'check' : 'close'} size={16} />
              <div class="grow"><div>{r.label}</div>{r.detail && <div class={r.ok ? 'small dim' : 'err'}>{r.detail}</div>}</div>
            </div>
          ))}
          <button class="btn primary" onClick={() => go('/')}>Go home</button>
        </div>
      )}
    </div>
  )
}
