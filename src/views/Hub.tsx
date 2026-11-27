// Settings > Plugins: everything connected, one row each, grouped by what it gives you, and one Add
// button. A row opens that plugin's or server's page (Manage.tsx); logins never appear here.

import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { go, items, notify, route, settings } from '../lib/store'
import * as Srv from '../lib/servers'
import { bus } from '../lib/sync/bus'
import { isDesktop } from '../lib/platform'
import { Icon } from '../components/icons'
import { useEscape } from '../lib/escape'
import { PluginIcon } from './Plugin'
import { absolute, install, installed, officialList, prepare, type Candidate, type Installed, type OfficialEntry } from '../lib/plugins/registry'
import { allServices, hasKey, type Service } from '../lib/plugins/services'
import type { PluginManifest, ThemeManifest } from '../lib/plugins/validate'
import { HUB, SERVER_KINDS, kindName, pageOf } from './Manage'
import { PROMPT, ReviewSheet } from './Plugins'
import { useAccount } from './Services'
import { anchorOf, reachLine } from '../lib/hub'

export function PluginsHub() {
  const [servers, setServers] = useState<Srv.Server[] | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    const load = () => Srv.getServers().then(setServers)
    load()
    bus.addEventListener('servers', load)
    return () => bus.removeEventListener('servers', load)
  }, [])
  const anchor = anchorOf(route.value)
  useEffect(() => {
    if (anchor && servers) (document.getElementById(anchor) ?? document.getElementById('plugins'))?.scrollIntoView({ block: 'start' })
  }, [anchor, servers !== null])

  const sources = installed.value.filter((p) => p.kind === 'source')
  const services = allServices.value
  const themes = installed.value.filter((p) => p.kind === 'theme')
  const none = servers !== null && !servers.length && !installed.value.length
  return (
    <section class="panel hub" id="plugins">
      <div class="hub-head">
        <h3>Plugins</h3>
        <button class="btn primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add</button>
      </div>
      {none && <p class="dim small">Nothing connected yet. Add a server on your network, a source like Stremio or YouTube, a debrid service, or a theme.</p>}
      {!!servers?.length && (
        <Group id="servers" title="Servers">
          {servers.map((s) => <Row href={pageOf(s.id)} icon={<Icon name="server" size={20} />} name={s.name} line={`${kindName(s.type)} · ${items.value.filter((i) => i.server === s.id).length.toLocaleString()} items`} />)}
        </Group>
      )}
      {sources.length > 0 && <Group id="sources" title="Sources">{sources.map((p) => <Row href={pageOf(p.id)} icon={<PluginIcon rec={p} size={20} />} name={p.manifest.name} line={pluginLine(p)} tag={!p.official} />)}</Group>}
      {services.length > 0 && <Group id="services" title="Streaming services">{services.map((s) => <ServiceRow s={s} />)}</Group>}
      {themes.length > 0 && (
        <Group id="themes" title="Themes">
          {themes.map((p) => <Row href={pageOf(p.id)} icon={<span class="swatch" style={{ background: (p.manifest as ThemeManifest).dark.accent }} />} name={p.manifest.name} line={settings.value.look === p.id ? 'In use' : 'Theme'} tag={!p.official} />)}
        </Group>
      )}
      {adding && <AddSheet onClose={() => setAdding(false)} />}
    </section>
  )
}

function pluginLine(p: Installed): string {
  if (p.pending) return 'An update waits for your OK'
  if (!p.enabled) return 'Off'
  return (p.manifest as PluginManifest).description ?? p.manifest.author
}

function Group({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return <div class="hub-group" id={id}><h4 class="small dim">{title}</h4>{children}</div>
}

function Row({ href, icon, name, line, tag }: { href: string; icon: ComponentChildren; name: string; line: string; tag?: boolean }) {
  return (
    <a class="list-row hub-row" href={`#${href}`}>
      {icon}
      <div class="grow">
        <div>{name} {tag && <span class="tag">Not from Flick</span>}</div>
        <div class="small dim hub-line">{line}</div>
      </div>
      <Icon name="left" size={16} class="chev" />
    </a>
  )
}

function ServiceRow({ s }: { s: Service }) {
  const { line } = useAccount(s)
  const text = !isDesktop ? 'Works in the desktop app' : s.pending ? 'An update waits for your OK' : !hasKey(s) ? 'Needs a key' : !s.enabled ? 'Off' : (line ?? 'Checking…').replace(`${s.manifest.name}: `, '')
  return <Row href={pageOf(s.id)} icon={<PluginIcon rec={s} size={20} />} name={s.manifest.name} line={text} tag={!s.official} />
}

const KIND_GROUPS = [['source', 'Sources'], ['service', 'Streaming services'], ['theme', 'Themes']] as const

function AddSheet({ onClose }: { onClose: () => void }) {
  const [official, setOfficial] = useState<OfficialEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)
  const [failed, setFailed] = useState<{ text: string; retry: () => void } | null>(null)
  const [cand, setCand] = useState<Candidate | null>(null)
  const [url, setUrl] = useState('')
  useEffect(() => { officialList().then(setOfficial) }, [])
  useEscape(true, () => { if (!busy) onClose() })

  const opened = (id: string) => { onClose(); go(pageOf(id)) }
  // Something from Flick's own list installs at once: the user picked it there, and the row said
  // what it reaches. Anything else, or an update, gets the review sheet first.
  const take = async (src: { url?: string; text?: string }, key: string) => {
    setBusy(key)
    setFailed(null)
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), 5000)
    try {
      const c = await prepare(src)
      if (c.official && !c.replaces) {
        const rec = await install(c)
        notify(`${rec.manifest.name} installed.`)
        opened(rec.id)
      } else setCand(c)
    } catch (e) {
      setFailed({ text: (e as Error).message, retry: () => take(src, key) })
    } finally {
      clearTimeout(timer)
      setBusy(null)
    }
  }
  const fromFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.js,.mjs,.json,text/javascript,application/json'
    input.onchange = async () => { const f = input.files?.[0]; if (f) take({ text: await f.text() }, 'file') }
    input.click()
  }
  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(PROMPT); notify('Prompt copied. Paste it into any AI agent.') } catch { prompt('Copy this prompt:', PROMPT) }
  }
  if (cand) return <ReviewSheet c={cand} onDone={(ok) => { if (ok) opened(cand.manifest.id); else setCand(null) }} />

  const have = new Set(installed.value.map((p) => p.url && absolute(p.url)))
  const offer = official.filter((o) => !have.has(absolute(o.url)) && (isDesktop || o.kind !== 'service'))
  const state = (key: string) => busy === key ? <span class="small dim">{slow ? 'Still starting the plugin…' : 'Installing…'}</span> : null
  return (
    <div class="sheet-back" role="dialog" aria-modal="true" aria-label="Add to Flick" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div class="sheet panel add-sheet">
        <h3>Add to Flick</h3>
        <h4 class="small dim">Servers</h4>
        {SERVER_KINDS.filter((k) => isDesktop || k.kind !== 'kodi').map((k) => (
          <a class="list-row hub-row" href={`#${HUB}/new/${k.kind}`} onClick={onClose}>
            <Icon name="server" size={20} />
            <div class="grow"><div>{k.name}</div><div class="small dim">{k.line}</div></div>
          </a>
        ))}
        {KIND_GROUPS.map(([kind, title]) => {
          const rows = offer.filter((o) => (o.kind ?? 'source') === kind)
          return rows.length > 0 && (
            <>
              <h4 class="small dim">{title}</h4>
              {rows.map((o) => (
                <button class="list-row hub-row" disabled={!!busy} onClick={() => take({ url: o.url }, o.url)}>
                  <Icon name={kind === 'theme' ? 'star' : 'plug'} size={20} />
                  <div class="grow">
                    <div>{o.name}</div>
                    {o.description && <div class="small dim">{o.description}</div>}
                    {o.hosts && <div class="small dim">{reachLine(o.hosts)}</div>}
                  </div>
                  {state(o.url)}
                </button>
              ))}
            </>
          )
        })}
        <h4 class="small dim">By address</h4>
        <form class="url-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) take({ url: url.trim() }, 'url') }}>
          <Icon name="link" size={16} />
          <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="https://…/plugin.js or theme.json" aria-label="Plugin address" />
          <button class="btn" disabled={!!busy || !url.trim()}>{busy === 'url' ? (slow ? 'Still starting…' : 'Reading…') : 'Add'}</button>
        </form>
        <div class="row">
          <button class="btn ghost sm" disabled={!!busy} onClick={fromFile}><Icon name="file" size={16} /> From a file</button>
          <button class="btn ghost sm" onClick={copyPrompt}><Icon name="plus" size={16} /> Make your own</button>
          {state('file')}
        </div>
        {failed && <p class="err">{failed.text} <button class="btn sm" onClick={failed.retry}>Retry</button></p>}
        <div class="row"><button class="btn ghost" disabled={!!busy} onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
