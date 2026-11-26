import { useEffect, useMemo, useState } from 'preact/hooks'
import { go } from '../lib/store'
import { fetchManifest } from '../lib/stremio'
import { isDesktop } from '../lib/platform'
import { decodeSetup, applySetup, describeSettings, type Setup as Payload, type SetupResult } from '../lib/setup'
import { prepare, type Candidate } from '../lib/plugins/registry'
import type { PluginManifest } from '../lib/plugins/validate'
import { Icon } from '../components/icons'

function pluginLine(u: string, c: Candidate | string | undefined): string {
  if (!c) return `Plugin at ${u} (reading…)`
  if (typeof c === 'string') return `Plugin at ${u}: ${c}`
  const m = c.manifest
  const hosts = c.kind === 'source' ? (m as PluginManifest).hosts.map((h) => (h === '*' ? 'any public website' : h)).join(', ') : ''
  return `${c.kind === 'theme' ? 'Theme' : 'Plugin'}: ${m.name} ${m.version} by ${m.author}${hosts ? `, reaches ${hosts}` : ''}${c.official ? '' : ' (Not from Flick)'}`
}

function preview(p: Payload, names: Record<string, string>, plugins: Record<string, Candidate | string>): string[] {
  return [
    ...(p.plugins ?? []).map((u) => pluginLine(u, plugins[u])),
    ...(p.stremioAddons ?? []).map((u) => `Stremio addon: ${names[u] ?? u}`),
    ...(p.servers ?? []).map((s) => `${s.type === 'plex' ? 'Plex' : s.type === 'flick' ? 'Flick' : 'Jellyfin'} server${s.name ? ` "${s.name}"` : ''} at ${s.url}`),
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
  const [plugins, setPlugins] = useState<Record<string, Candidate | string>>({})

  useEffect(() => {
    for (const u of parsed.p?.stremioAddons ?? []) {
      fetchManifest(u).then((a) => setNames((n) => ({ ...n, [u]: a.manifest.name }))).catch(() => setNames((n) => ({ ...n, [u]: `${u} (not answering)` })))
    }
    for (const u of parsed.p?.plugins ?? []) {
      prepare({ url: u }).then((c) => setPlugins((x) => ({ ...x, [u]: c }))).catch((e) => setPlugins((x) => ({ ...x, [u]: (e as Error).message })))
    }
  }, [parsed])

  const connect = async () => {
    if (!parsed.p) return
    setBusy(true)
    const ready = Object.fromEntries(Object.entries(plugins).filter((e): e is [string, Candidate] => typeof e[1] !== 'string'))
    setResults(await applySetup(parsed.p, ready))
    setBusy(false)
  }

  const lines = parsed.p ? preview(parsed.p, names, plugins) : []
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
