// Debrid service pieces for their plugin pages: the account line, the key form (a key is checked
// before it is saved) and keys found in the user's Stremio addons.

import { useEffect, useState } from 'preact/hooks'
import { notify, settings, setSettings } from '../lib/store'
import { isDesktop } from '../lib/platform'
import { acceptUpdate, absolute, installed, officialList, prepare, setEnabled, type Candidate, type OfficialEntry } from '../lib/plugins/registry'
import { callPlugin } from '../lib/plugins/runtime'
import { accountLine, allServices, checkAndSave, hasKey, keyField, keyOffers, moveService, removeService, STREMIO_ID, stremioAddonUrls, takeFoundKey, type Service } from '../lib/plugins/services'
import { keyEnd, type FoundKey } from '../lib/plugins/debrid-keys'
import type { PluginManifest } from '../lib/plugins/validate'

/** Keys in the user's Stremio addons, offered one button each. Nothing is saved before the tap. */
export function FromStremio({ only }: { only?: string } = {}) {
  const [urls, setUrls] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const rec = installed.value.find((p) => p.id === STREMIO_ID)
  useEffect(() => {
    let stale = false
    stremioAddonUrls().then((u) => { if (!stale) setUrls(u) })
    return () => { stale = true }
  }, [rec?.enabled, rec?.official, rec?.sha256, rec && JSON.stringify(rec.settings)])
  const offers = keyOffers(urls, allServices.value).filter((f) => !only || f.serviceId === only)
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

/** The service's account line ("TorBox: Pro until 2027-03-01"), checked when its key or code changes. */
export function useAccount(s: Service): { line: string | null; bad: boolean } {
  const [line, setLine] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const keyed = hasKey(s)
  useEffect(() => {
    if (!keyed || !s.enabled) return
    setLine(null)
    setBad(false)
    let stale = false
    callPlugin(s, 'account', []).then(
      (r) => { if (!stale) { setLine(accountLine(s.manifest.name, r)); setBad(!r.ok) } },
      (e) => { if (!stale) { setLine(`${s.manifest.name}: ${(e as Error).message}`); setBad(true) } },
    )
    return () => { stale = true }
  }, [s.sha256, keyed && String(s.settings[keyField(s.manifest)!]), s.enabled])
  return { line, bad }
}

export function KeyForm({ from, onSaved }: { from: Candidate | Service; onSaved?: () => void }) {
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
