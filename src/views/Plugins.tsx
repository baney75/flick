// Settings > Plugins: installed plugins and themes, the review sheet before any install, the official
// list, settings and action forms, each plugin's log, and a prompt for making your own.

import { useEffect, useState } from 'preact/hooks'
import { notify, settings, setSettings } from '../lib/store'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'
import { PluginIcon } from './Plugin'
import { installed, prepare, install, remove, setEnabled, setPluginSettings, acceptUpdate, officialList, absolute, type Candidate, type OfficialEntry } from '../lib/plugins/registry'
import { callPlugin, logs, type Installed } from '../lib/plugins/runtime'
import { themes } from '../lib/plugins/use'
import type { ActionDef, Field, PluginManifest, ThemeManifest } from '../lib/plugins/validate'

const DOCS = 'https://github.com/baney75/flick/blob/main/docs/PLUGINS.md'
const PROMPT = `Write a Flick plugin for: <the site, API or service you want in Flick>.
Read the contract at ${DOCS} and follow the skill at https://github.com/baney75/flick/blob/main/skills/flick-plugin/SKILL.md.
Start from https://raw.githubusercontent.com/baney75/flick/main/plugins/template/plugin.js.
Clone https://github.com/baney75/flick, run npm install, and run npm run plugin:check -- plugin.js until every line is PASS.
Then publish plugin.js as a GitHub gist and give me its raw URL (without the commit hash) to paste into Flick under Settings > Plugins > Add by URL.`

const hostWords = (h: string) => (h === '*' ? 'any public website' : h)

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

export function PluginsPanel() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [cand, setCand] = useState<Candidate | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [official, setOfficial] = useState<OfficialEntry[]>([])
  useEffect(() => { officialList().then(setOfficial) }, [])

  const review = async (src: { url?: string; text?: string }) => {
    setBusy(true)
    try { setCand(await prepare(src)) } catch (e) { notify(`Plugin: ${(e as Error).message}`, 6000) }
    setBusy(false)
  }
  const fromFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.js,.mjs,.json,text/javascript,application/json'
    input.onchange = async () => { const f = input.files?.[0]; if (f) review({ text: await f.text() }) }
    input.click()
  }
  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(PROMPT); notify('Prompt copied. Paste it into any AI agent.') } catch { prompt('Copy this prompt:', PROMPT) }
  }

  const have = new Set(installed.value.map((p) => p.url && absolute(p.url)))
  const offer = official.filter((o) => o.kind !== 'service' && !have.has(absolute(o.url)))
  return (
    <section class="panel">
      <h3>Plugins</h3>
      <p class="dim small">Plugins add sources (catalogs, search, streams) and themes; debrid services are under Streaming services. Each source runs in its own sandbox. Flick never installs one without your tap.</p>
      {installed.value.filter((p) => p.kind !== 'service').map((p) => <PluginRow p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />)}
      <form class="url-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) review({ url: url.trim() }) }}>
        <Icon name="link" size={16} />
        <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="https://…/plugin.js or theme.json" aria-label="Plugin address" />
        <button class="btn" disabled={busy || !url.trim()}>{busy ? 'Reading…' : 'Add'}</button>
      </form>
      <div class="row">
        <button class="btn ghost sm" onClick={fromFile}><Icon name="file" size={16} /> From a file</button>
        <button class="btn ghost sm" onClick={copyPrompt}><Icon name="plus" size={16} /> Make your own</button>
      </div>
      {offer.length > 0 && <h4 class="small dim">From Flick</h4>}
      {offer.map((o) => (
        <div class="list-row">
          <Icon name="plug" size={18} />
          <div class="grow"><div>{o.name}</div>{o.description && <div class="small dim">{o.description}</div>}</div>
          <button class="btn sm" disabled={busy} onClick={() => review({ url: o.url })}>Install</button>
        </div>
      ))}
      {cand && <ReviewSheet c={cand} onDone={(ok) => { setCand(null); if (ok) setUrl('') }} />}
    </section>
  )
}

function PluginRow({ p, open, onToggle }: { p: Installed; open: boolean; onToggle: () => void }) {
  const m = p.manifest
  const src = p.kind === 'source' ? (m as PluginManifest) : null
  const drop = async () => {
    if (!confirm(`Remove ${m.name}? Its saved data on this device goes too.`)) return
    if (settings.value.look === p.id) setSettings({ look: '' })
    await remove(p.id)
  }
  return (
    <div class="plugin-row">
      <div class="list-row">
        {p.kind === 'theme' ? <span class="swatch" style={{ background: (m as ThemeManifest).dark.accent }} /> : <PluginIcon rec={p} size={20} />}
        <div class="grow">
          <div>{m.name} <span class="small dim">v{m.version}</span> {!p.official && <span class="tag">Not from Flick</span>}</div>
          <div class="small dim">{p.kind === 'theme' ? 'Theme' : m.author}{src && !p.enabled ? ' · off' : ''}</div>
        </div>
        {src && <label class="toggle"><input type="checkbox" checked={p.enabled} onChange={(e) => setEnabled(p.id, (e.target as HTMLInputElement).checked)} aria-label={`Turn ${m.name} on`} /></label>}
        {src && p.enabled && <a class="btn ghost sm" href={`#/p/${encodeURIComponent(p.id)}`} aria-label={`Open ${m.name}`}>Open</a>}
        {src && <button class="btn ghost sm" onClick={onToggle} aria-expanded={open}>{open ? 'Close' : 'Manage'}</button>}
        <button class="btn ghost sm" onClick={drop}>Remove</button>
      </div>
      {p.pending && (
        <div class="warn-box small">
          An update to {p.pending.manifest.version} asks to {p.pending.added.join(', ')}.
          <button class="btn sm" onClick={() => acceptUpdate(p.id)}>Allow and update</button>
        </div>
      )}
      {open && src && (
        <div class="plugin-detail">
          {src.description && <p class="small dim">{src.description}</p>}
          <p class="small dim">Reaches {src.hosts.length ? src.hosts.map(hostWords).join(', ') : 'only what the browser allows'}.{p.url ? ` From ${absolute(p.url)}.` : ''}</p>
          {src.settings.length > 0 && <SettingsForm p={p} fields={src.settings} />}
          {src.actions.map((a) => <ActionForm p={p} a={a} />)}
          <details>
            <summary class="small">Log</summary>
            <pre class="plugin-log">{(logs.value[p.id] ?? []).join('\n') || 'Nothing yet.'}</pre>
          </details>
        </div>
      )}
    </div>
  )
}

function FieldInput({ f, value, set }: { f: Field; value: unknown; set: (v: unknown) => void }) {
  const id = `f-${f.key}`
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

function SettingsForm({ p, fields }: { p: Installed; fields: Field[] }) {
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

function ActionForm({ p, a }: { p: Installed; a: ActionDef }) {
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
