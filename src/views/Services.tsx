// Settings > Streaming services: add a debrid service with its API key (checked before it is saved),
// see each account's plan, set their order, remove one with a tap, and choose whether they need the VPN.

import { useEffect, useState } from 'preact/hooks'
import { notify, settings, setSettings } from '../lib/store'
import { isDesktop } from '../lib/platform'
import { acceptUpdate, absolute, installed, officialList, prepare, setEnabled, type Candidate, type OfficialEntry } from '../lib/plugins/registry'
import { callPlugin } from '../lib/plugins/runtime'
import { accountLine, allServices, checkAndSave, hasKey, keyField, keyOffers, moveService, removeService, stremioAddonUrls, takeFoundKey, type Service } from '../lib/plugins/services'
import { keyEnd, type FoundKey } from '../lib/plugins/debrid-keys'
import type { PluginManifest } from '../lib/plugins/validate'

export function ServicesPanel() {
  return (
    <section class="panel" id="services">
      <h3>Streaming services</h3>
      {isDesktop ? <Services /> : <p class="dim small">TorBox, Real-Debrid and other debrid services work in the Flick desktop app.</p>}
    </section>
  )
}

function Services() {
  const [official, setOfficial] = useState<OfficialEntry[]>([])
  useEffect(() => { officialList().then(setOfficial) }, [])
  const list = allServices.value
  const have = new Set(installed.value.map((p) => p.url && absolute(p.url)))
  const offer = official.filter((o) => o.kind === 'service' && !have.has(absolute(o.url)))
  return (
    <>
      <p class="dim small">A debrid service fetches a torrent on its own servers and Flick plays it from there over https, so nothing is shared from this computer. Your key stays on this device and goes only to that service.</p>
      <FromStremio />
      {list.map((s, i) => <ServiceRow s={s} first={i === 0} last={i === list.length - 1} />)}
      {offer.length > 0 && <AddService offer={offer} />}
      <label class="toggle">
        <input type="checkbox" checked={settings.value.debridNeedsVpn} onChange={(e) => setSettings({ debridNeedsVpn: (e.target as HTMLInputElement).checked })} />
        Require a VPN for debrid services too
      </label>
      <p class="dim small">Off, services that send the video only from their own servers (all four from Flick) play with or without a VPN, and the player says which. Torrents Flick plays itself always need the VPN.</p>
    </>
  )
}

/** Keys in the user's Stremio addons, offered one button each. Nothing is saved before the tap. */
function FromStremio() {
  const [urls, setUrls] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { stremioAddonUrls().then(setUrls) }, [installed.value.find((p) => p.id === 'dev.flick.stremio')?.enabled])
  const offers = keyOffers(urls, allServices.value)
  if (!offers.length && !msg) return null
  const use = async (f: FoundKey) => {
    setBusy(f.serviceId + f.key)
    setMsg(null)
    try {
      const r = await takeFoundKey(f)
      if (r.ok) notify(r.line); else setMsg(r.line)
    } catch (e) { setMsg((e as Error).message) }
    setBusy(null)
  }
  return (
    <div class="from-stremio">
      {offers.map((f) => (
        <div class="list-row">
          <div class="grow">Use the {f.service} key from your {f.addon} setup <span class="small dim">(ends in {keyEnd(f.key)})</span></div>
          <button class="btn sm" disabled={!!busy} onClick={() => use(f)}>{busy === f.serviceId + f.key ? 'Checking…' : 'Use this key'}</button>
        </div>
      ))}
      {msg && <p class="err">{msg}</p>}
    </div>
  )
}

function ServiceRow({ s, first, last }: { s: Service; first: boolean; last: boolean }) {
  const [line, setLine] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const [change, setChange] = useState(false)
  const keyed = hasKey(s)
  useEffect(() => {
    if (!keyed || !s.enabled) return
    setLine(null)
    setBad(false)
    callPlugin(s, 'account', []).then(
      (r) => { setLine(accountLine(s.manifest.name, r)); setBad(!r.ok) },
      (e) => { setLine(`${s.manifest.name}: ${(e as Error).message}`); setBad(true) },
    )
  }, [s.sha256, keyed && String(s.settings[keyField(s.manifest)!]), s.enabled])
  const drop = async () => { await removeService(s.id); notify(`${s.manifest.name} removed, with its key.`) }
  return (
    <div class="plugin-row">
      <div class="list-row">
        <div class="grow">
          <div>{s.manifest.name} {!s.official && <span class="tag">Not from Flick</span>}</div>
          <div class="small dim service-status">{!keyed ? 'No key yet' : !s.enabled ? 'Off' : line ?? 'Checking…'}</div>
        </div>
        <label class="toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => setEnabled(s.id, (e.target as HTMLInputElement).checked)} aria-label={`Turn ${s.manifest.name} on`} /></label>
        {keyed && <button class="btn ghost sm" onClick={() => setChange(!change)} aria-expanded={change}>{change ? 'Keep key' : 'Change key'}</button>}
        {!first && <button class="btn ghost sm" onClick={() => moveService(s.id, -1)} aria-label={`Move ${s.manifest.name} up`}>Up</button>}
        {!last && <button class="btn ghost sm" onClick={() => moveService(s.id, 1)} aria-label={`Move ${s.manifest.name} down`}>Down</button>}
        <button class="btn ghost sm" onClick={drop} aria-label={`Remove ${s.manifest.name}`}>Remove</button>
      </div>
      {s.pending && (
        <div class="warn-box small">
          An update to {s.pending.manifest.version} asks to {s.pending.added.join(', ')}.
          <button class="btn sm" onClick={() => acceptUpdate(s.id)}>Allow and update</button>
        </div>
      )}
      {(!keyed || bad || change) && <KeyForm from={s} onSaved={() => setChange(false)} />}
    </div>
  )
}

function AddService({ offer }: { offer: OfficialEntry[] }) {
  const [url, setUrl] = useState('')
  const [cand, setCand] = useState<Candidate | null>(null)
  useEffect(() => {
    setCand(null)
    let stale = false
    if (url) prepare({ url }).then((c) => { if (!stale) setCand(c) }, (e) => { if (!stale) notify(`${offer.find((o) => o.url === url)?.name ?? 'Service'}: ${(e as Error).message}`) })
    return () => { stale = true }
  }, [url])
  return (
    <div class="plugin-form">
      <label>Add a service
        <select value={url} onChange={(e) => setUrl((e.target as HTMLSelectElement).value)} aria-label="Service to add">
          <option value="">Choose…</option>
          {offer.map((o) => <option value={o.url}>{o.name}</option>)}
        </select>
      </label>
      {cand && <KeyForm from={cand} onSaved={() => setUrl('')} />}
    </div>
  )
}

function KeyForm({ from, onSaved }: { from: Candidate | Service; onSaved?: () => void }) {
  const m = from.manifest as PluginManifest
  const f = m.settings.find((x) => x.key === keyField(m))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const r = await checkAndSave(from, key)
      if (r.ok) { setKey(''); notify(r.line); onSaved?.() } else setMsg({ ok: false, text: r.line })
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form class="plugin-form" onSubmit={save}>
      <label>{m.name} {f?.label ?? 'API key'} <span class="small dim">(stays on this device)</span>
        <input type="password" autocomplete="off" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} aria-label={`${m.name} API key`} />
        {f?.help && <span class="small dim">{f.help}</span>}
      </label>
      <button class="btn sm" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Check and save'}</button>
      {msg && <p class="err">{msg.text}</p>}
    </form>
  )
}
