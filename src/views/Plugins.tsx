// Plugin pieces the hub and plugin pages share: the review sheet before any install, the theme
// picker, settings and action forms, and the prompt for making your own.

import { useEffect, useState } from 'preact/hooks'
import { notify, settings, setSettings } from '../lib/store'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'
import { PluginIcon } from './Plugin'
import { installed, prepare, install, remove, setEnabled, setPluginSettings, acceptUpdate, officialList, absolute, type Candidate, type OfficialEntry } from '../lib/plugins/registry'
import { callPlugin, logs, type Installed } from '../lib/plugins/runtime'
import { themes } from '../lib/plugins/use'
import type { ActionDef, Field, PluginManifest, ThemeManifest } from '../lib/plugins/validate'
import { maskAddress } from '../lib/plugins/debrid-keys'
import { noVpnFact } from '../lib/debrid-play'

const DOCS = 'https://github.com/baney75/flick/blob/main/docs/PLUGINS.md'
export const PROMPT = `Write a Flick plugin for: <the site, API or service you want in Flick>.
Read the contract at ${DOCS} and follow the skill at https://github.com/baney75/flick/blob/main/skills/flick-plugin/SKILL.md.
Start from https://raw.githubusercontent.com/baney75/flick/main/plugins/template/plugin.js.
The plugin may name its own kinds (podcast, recipe) and return its library as shelves that become chips in Flick's Library.
Clone https://github.com/baney75/flick, run npm install, and run npm run plugin:check -- plugin.js until every line is PASS.
Then publish plugin.js as a GitHub gist and give me its raw URL (without the commit hash) to paste into Flick under Settings > Plugins > Add by URL.`

export const hostWords = (h: string) => (h === '*' ? 'any public website' : h)

export function ReviewSheet({ c, extra, onDone }: { c: Candidate; extra?: string; onDone: (installed: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const m = c.manifest
  const src = c.kind !== 'theme' ? (m as PluginManifest) : null
  const go = async () => {
    setBusy(true)
    try {
      await install(c)
      notify(`${m.name} installed.`)
      onDone(true)
    } catch (e) {
      notify((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div class="sheet-back" role="dialog" aria-modal="true" aria-label={`Install ${m.name}`}>
      <div class="sheet panel">
        <h3>{c.replaces ? `Update ${m.name}?` : `Install ${m.name}?`}</h3>
        {!c.official && <p class="warn-box"><Icon name="external" size={16} /> Not from Flick. Install it only if you trust {m.author}.</p>}
        <div class="facts-list">
          <div><span class="dim">Kind</span> {c.kind === 'theme' ? 'Theme (colors only, runs no code)' : c.kind === 'service' ? 'Debrid service (set it up under Streaming services)' : 'Source plugin'}</div>
          <div><span class="dim">Version</span> {m.version}{c.replaces ? ` (you have ${c.replaces.manifest.version})` : ''}</div>
          <div><span class="dim">Author</span> {m.author}</div>
          {c.url && <div><span class="dim">From</span> <span class="small">{absolute(c.url)}</span></div>}
          {src && <div><span class="dim">Reaches</span> {src.hosts.length ? src.hosts.map(hostWords).join(', ') : 'nothing'}</div>}
          {src && src.tools.length > 0 && <div><span class="dim">Desktop tools</span> {src.tools.join(', ')}</div>}
          {src && src.platforms.length < 3 && <div><span class="dim">Works on</span> {src.platforms.join(', ')}</div>}
          {noVpnFact(c) && <div><span class="dim">VPN</span> {noVpnFact(c)}</div>}
        </div>
        {src?.description && <p class="small">{src.description}</p>}
        {extra && <p class="small dim">{extra}</p>}
        {src && <p class="small dim">It runs in a sandbox: it cannot read your library, other plugins, your sync key or your server tokens.</p>}
        {src && !isDesktop && <p class="small dim web-hosts">On the website the browser cannot hold a plugin to that list: it can also reach any site that allows it. The Flick apps enforce the list.</p>}
        <div class="row">
          <button class="btn primary" onClick={go} disabled={busy}>{busy ? 'Installing…' : c.replaces ? 'Update' : 'Install'}</button>
          <button class="btn ghost" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function ThemePicker() {
  const look = settings.value.look
  return (
    <label>Colors
      <select value={look} onChange={(e) => setSettings({ look: (e.target as HTMLSelectElement).value })}>
        <option value="">Flick</option>
        {themes.value.map((t) => <option value={t.id}>{t.name}</option>)}
        {look && !themes.value.some((t) => t.id === look) && <option value={look}>{look} (not installed)</option>}
      </select>
    </label>
  )
}

function FieldInput({ f, value, set }: { f: Field; value: unknown; set: (v: unknown) => void }) {
  const id = `f-${f.key}`
  // A secret list (Stremio's addon addresses) is never shown or edited as raw text: each entry shows with
  // any debrid key cut to its last 4. The plugin's Addons section adds them; Remove here also clears an
  // entry that no longer loads, which Addons cannot list.
  if (f.type === 'list' && f.secret) {
    const entries = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    return (
      <div role="group" aria-label={f.label} style={{ display: 'grid', gap: '4px' }}>
        <span>{f.label}<span class="small dim"> (stays on this device)</span></span>
        {entries.length
          ? <ul class="small" style={{ margin: 0, paddingLeft: '18px' }}>{entries.map((u, i) => (
            <li key={u} style={{ overflowWrap: 'anywhere' }}>
              {maskAddress(u)} <button type="button" class="link-btn" aria-label={`Remove entry ${i + 1}, ${maskAddress(u)}`} onClick={() => set(entries.filter((x) => x !== u))}>Remove</button>
            </li>
          ))}</ul>
          : <span class="small dim">None yet.</span>}
        {f.help && <span class="small dim">{f.help}</span>}
      </div>
    )
  }
  if (f.type === 'toggle') return <label class="toggle"><input type="checkbox" checked={!!value} onChange={(e) => set((e.target as HTMLInputElement).checked)} /> {f.label}</label>
  const input = f.type === 'select'
    ? <select id={id} value={String(value ?? '')} onChange={(e) => set((e.target as HTMLSelectElement).value)}>{(f.options ?? []).map((o) => <option value={o}>{o}</option>)}</select>
    : f.type === 'list'
      ? <textarea id={id} rows={3} value={Array.isArray(value) ? value.join('\n') : ''} onInput={(e) => set((e.target as HTMLTextAreaElement).value.split('\n').map((x) => x.trim()).filter(Boolean))} />
      : f.type === 'password'
        ? <input id={id} type="password" autocomplete="current-password" value={String(value ?? '')} onInput={(e) => set((e.target as HTMLInputElement).value)} />
        : <input id={id} type="text" autocomplete="off" value={String(value ?? '')} onInput={(e) => set((e.target as HTMLInputElement).value)} />
  return (
    <label>{f.label}{f.secret && <span class="small dim"> (stays on this device)</span>}
      {input}
      {f.help && <span class="small dim">{f.help}</span>}
    </label>
  )
}

export function SettingsForm({ p, fields }: { p: Installed; fields: Field[] }) {
  const [vals, setVals] = useState<Record<string, unknown>>(p.settings)
  const save = async (e: Event) => {
    e.preventDefault()
    await setPluginSettings(p.id, vals)
    notify(`${p.manifest.name} settings saved.`)
  }
  return (
    <form class="plugin-form" onSubmit={save}>
      {fields.map((f) => <FieldInput f={f} value={vals[f.key]} set={(v) => setVals({ ...vals, [f.key]: v })} />)}
      <button class="btn sm">Save settings</button>
    </form>
  )
}

export function ActionForm({ p, a }: { p: Installed; a: ActionDef }) {
  const [vals, setVals] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const r = await callPlugin(p, 'action', [a.id, vals])
      setMsg({ ok: r.ok, text: r.message ?? (r.ok ? 'Done.' : 'That did not work.') })
      // Field values go to this one call only; secrets are cleared right away.
      setVals(Object.fromEntries(Object.entries(vals).filter(([k]) => !a.fields.find((f) => f.key === k)?.secret)))
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    }
    setBusy(false)
  }
  return (
    <form class="plugin-form" onSubmit={run}>
      {a.fields.map((f) => <FieldInput f={f} value={vals[f.key]} set={(v) => setVals({ ...vals, [f.key]: v })} />)}
      <button class="btn sm" disabled={busy}>{busy ? 'Working…' : a.label}</button>
      {msg && <p class={msg.ok ? 'small' : 'err'}>{msg.text}</p>}
    </form>
  )
}
