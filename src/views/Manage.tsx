// One page per plugin or server, under Settings > Plugins: `#/settings/plugins/<id>` for anything
// connected, `#/settings/plugins/new/<kind>` for a server being added. Sign-in, keys, settings,
// actions, on and off, sync, order, the log and Remove all live here, never in the list.

import type { ComponentChildren } from 'preact'
import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { go, items, notify, reloadItems, settings, setSettings } from '../lib/store'
import * as Srv from '../lib/servers'
import { isDesktop } from '../lib/platform'
import { Icon } from '../components/icons'
import { PluginIcon } from './Plugin'
import { acceptUpdate, absolute, installed, pluginsLoaded, remove, setEnabled, type Installed } from '../lib/plugins/registry'
import { logs } from '../lib/plugins/runtime'
import { allServices, hasKey, moveService, removeService, type Service } from '../lib/plugins/services'
import type { PluginManifest, ThemeManifest } from '../lib/plugins/validate'
import { FlickForm, JellyfinForm, KodiForm, PlexForm } from './Servers'
import { ActionForm, SettingsForm, hostWords } from './Plugins'
import { ExtensionsSection } from './Extensions'
import { FromStremio, KeyForm, useAccount } from './Services'

export const HUB = '/settings/plugins'
export const pageOf = (id: string) => `${HUB}/${encodeURIComponent(id)}`

export const SERVER_KINDS = [
  { kind: 'flick', name: 'Flick server (NAS)', line: 'The flick-server program on your NAS or another computer.' },
  { kind: 'jellyfin', name: 'Jellyfin or Emby', line: 'Your Jellyfin or Emby server, with your username and password.' },
  { kind: 'plex', name: 'Plex', line: 'Sign in on plex.tv; Flick finds your servers.' },
  { kind: 'kodi', name: 'Kodi', line: 'Kodi on your network, through its remote control setting.' },
] as const
export type ServerKind = (typeof SERVER_KINDS)[number]['kind']
export const kindName = (k: Srv.Server['type']) => SERVER_KINDS.find((x) => x.kind === k)?.name ?? k

/** The server Flick is syncing right now, so its page can say so after an add moves to it. */
const syncing = signal<ReadonlySet<string>>(new Set())

async function syncNow(s: Srv.Server) {
  if (syncing.value.has(s.id)) return
  syncing.value = new Set([...syncing.value, s.id])
  try {
    const n = await Srv.syncServer(s)
    await reloadItems()
    notify(`${s.name}: ${n} items in your library.`)
  } catch (e) {
    notify(`${s.name}: ${(e as Error).message}`)
  }
  syncing.value = new Set([...syncing.value].filter((x) => x !== s.id))
}

/** `path` is what follows `#/settings/plugins/`, decoded: [id] or ['new', kind]. */
export function Manage({ path }: { path: string[] }) {
  const [servers, setServers] = useState<Srv.Server[] | null>(null)
  useEffect(() => { Srv.getServers().then(setServers) }, [path.join('/')])
  if (path[0] === 'new') return <Frame title={`Add ${SERVER_KINDS.find((k) => k.kind === path[1])?.name ?? 'a server'}`}><NewServer kind={path[1]} /></Frame>
  const id = path[0]
  const p = installed.value.find((x) => x.id === id)
  if (p) return <Frame title={p.manifest.name} icon={p.kind === 'theme' ? <span class="swatch" style={{ background: (p.manifest as ThemeManifest).dark.accent }} /> : <PluginIcon rec={p} size={28} />}><PluginBody p={p} /></Frame>
  const s = servers?.find((x) => x.id === id)
  if (s) return <Frame title={s.name} icon={<Icon name="server" size={28} />}><ServerBody s={s} /></Frame>
  if (!servers || !pluginsLoaded.value) return <div class="page narrow manage" />
  return <Frame title="Not connected"><p class="dim">Nothing with that name is connected on this device.</p></Frame>
}

function Frame({ title, icon, children }: { title: string; icon?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="page narrow manage">
      <a class="back-link small" href={`#${HUB}`}><Icon name="left" size={14} /> Plugins</a>
      <header class="page-head">{icon}<h1>{title}</h1></header>
      {children}
    </div>
  )
}

function NewServer({ kind }: { kind?: string }) {
  const [here, setHere] = useState<Srv.FlickInfo | null>(null)
  useEffect(() => { if (kind === 'flick') Srv.sameOriginFlick().then(setHere) }, [kind])
  // Plex may hand back several servers; each is saved and synced, and the page shows the last.
  const add = async (s: Srv.Server) => {
    await Srv.saveServer(s)
    go(pageOf(s.id))
    await syncNow(s)
  }
  const form = kind === 'flick' ? <FlickForm onAdd={add} here={here} heading={false} />
    : kind === 'jellyfin' ? <JellyfinForm onAdd={add} heading={false} />
      : kind === 'plex' ? <PlexForm onAdd={add} heading={false} />
        : kind === 'kodi' && isDesktop ? <KodiForm onAdd={add} heading={false} />
          : null
  return (
    <>
      {form ?? <p class="dim">{kind === 'kodi' ? 'Kodi works in the Flick apps.' : 'Flick has no server of that kind.'}</p>}
      {form && <p class="small dim">Flick talks to your server directly from this device. If the website cannot reach a server on your home network, use the desktop app, or put the server behind HTTPS.</p>}
    </>
  )
}

function ServerBody({ s }: { s: Srv.Server }) {
  const n = items.value.filter((i) => i.server === s.id).length
  const busy = syncing.value.has(s.id)
  const drop = async () => {
    if (!confirm(`Remove ${s.name}? Its titles leave your library on this device; the server keeps its files.`)) return
    try {
      await Srv.removeServer(s)
      await reloadItems()
    } catch (e) { notify(`${s.name}: ${(e as Error).message}`); return }
    notify(`${s.name} removed.`)
    go(HUB)
  }
  return (
    <section class="panel">
      <div class="facts-list">
        <div><span class="dim">Kind</span> {kindName(s.type)}</div>
        <div><span class="dim">Address</span> <span class="small">{s.url}</span></div>
        <div><span class="dim">In your library</span> {busy ? 'Syncing…' : `${n.toLocaleString()} items`}</div>
      </div>
      <div class="row">
        <button class="btn primary" onClick={() => syncNow(s)} disabled={busy}><Icon name="refresh" size={16} /> {busy ? 'Syncing' : 'Sync now'}</button>
        <button class="btn ghost" onClick={drop}>Remove</button>
      </div>
    </section>
  )
}

function PluginBody({ p }: { p: Installed }) {
  const m = p.manifest
  const src = p.kind !== 'theme' ? (m as PluginManifest) : null
  const drop = async () => {
    if (!confirm(`Remove ${m.name}? Its saved data on this device goes too.`)) return
    if (settings.value.look === p.id) setSettings({ look: '' })
    try {
      if (p.kind === 'service') await removeService(p.id); else await remove(p.id)
    } catch (e) { notify(`${m.name}: ${(e as Error).message}`); return }
    notify(`${m.name} removed.`)
    go(HUB)
  }
  return (
    <>
      <p class="small dim">v{m.version} · {m.author} {!p.official && <span class="tag">Not from Flick</span>}</p>
      {p.pending && (
        <div class="warn-box small">
          An update to {p.pending.manifest.version} asks to {p.pending.added.join(', ')}.
          <button class="btn sm" onClick={() => acceptUpdate(p.id)}>Allow and update</button>
        </div>
      )}
      <section class="panel">
        {src?.description && <p>{src.description}</p>}
        {src && <p class="small dim">Reaches {src.hosts.length ? src.hosts.map(hostWords).join(', ') : 'only what the browser allows'}.{p.url ? ` From ${absolute(p.url)}.` : ''}</p>}
        {src && <label class="toggle"><input type="checkbox" checked={p.enabled} onChange={(e) => setEnabled(p.id, (e.target as HTMLInputElement).checked)} /> On</label>}
        {p.kind === 'source' && p.enabled && <a class="btn" href={`#/p/${encodeURIComponent(p.id)}`}>Open {m.name}</a>}
        {p.kind === 'theme' && (settings.value.look === p.id
          ? <p class="small">In use. <button class="link-btn" onClick={() => setSettings({ look: '' })}>Use Flick's colors</button></p>
          : <button class="btn" onClick={() => setSettings({ look: p.id })}>Use these colors</button>)}
      </section>
      {p.kind === 'service' && <ServiceBody s={p as Service} />}
      {p.kind === 'source' && src && (src.settings.length > 0 || src.actions.length > 0) && (
        <section class="panel">
          {src.actions.map((a) => <ActionForm p={p} a={a} />)}
          {/* Keyed on the saved settings, so an addon added below shows here and a later Save keeps it. */}
          {src.settings.length > 0 && <SettingsForm key={JSON.stringify(p.settings)} p={p} fields={src.settings} />}
        </section>
      )}
      {p.kind === 'source' && src?.has.extensions && <section class="panel"><ExtensionsSection p={p} /></section>}
      {src && (
        <details class="panel">
          <summary class="small">Log</summary>
          <pre class="plugin-log">{(logs.value[p.id] ?? []).join('\n') || 'Nothing yet.'}</pre>
        </details>
      )}
      <button class="btn ghost" onClick={drop}>Remove {m.name}</button>
    </>
  )
}

function ServiceBody({ s }: { s: Service }) {
  const [change, setChange] = useState(false)
  const keyed = hasKey(s)
  const { line, bad } = useAccount(s)
  const list = allServices.value
  const at = list.findIndex((x) => x.id === s.id)
  if (!isDesktop) return <section class="panel"><p class="dim small">TorBox, Real-Debrid and other debrid services work in the Flick desktop app.</p></section>
  return (
    <section class="panel">
      <p class="service-status">{!keyed ? 'No key yet' : !s.enabled ? 'Off' : line ?? 'Checking…'}</p>
      {!keyed && <FromStremio only={s.id} />}
      {(!keyed || bad || change) && <KeyForm from={s} onSaved={() => setChange(false)} />}
      <div class="row">
        {keyed && <button class="btn ghost sm" onClick={() => setChange(!change)} aria-expanded={change}>{change ? 'Keep key' : 'Change key'}</button>}
        {list.length > 1 && <span class="small dim">Tried {ordinal(at + 1)} of {list.length}</span>}
        {at > 0 && <button class="btn ghost sm" onClick={() => moveService(s.id, -1)} aria-label={`Try ${s.manifest.name} sooner`}>Sooner</button>}
        {at >= 0 && at < list.length - 1 && <button class="btn ghost sm" onClick={() => moveService(s.id, 1)} aria-label={`Try ${s.manifest.name} later`}>Later</button>}
      </div>
      <label class="toggle">
        <input type="checkbox" checked={settings.value.debridNeedsVpn} onChange={(e) => setSettings({ debridNeedsVpn: (e.target as HTMLInputElement).checked })} />
        Require a VPN for debrid services too
      </label>
      <p class="dim small">A debrid service fetches a torrent on its own servers and Flick plays it from there over https, so nothing is shared from this computer. Your key stays on this device and goes only to {s.manifest.name}.</p>
    </section>
  )
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`
