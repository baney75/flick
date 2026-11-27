// A plugin's Addons (SPEC-plugins-hub rule 10): what is installed in it with Remove, Add by address,
// and Browse with search. Nothing is added without a tap, and every add shows the addon's name, what it
// provides and its host in one confirm step first. Debrid keys in addon addresses show only their last 4.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/icons'
import { notify } from '../lib/store'
import { addExtension, browseExtensions, hasExtensions, hostOf, inspectExtension, listExtensions, maskUrl, removeExtension } from '../lib/plugins/extensions'
import type { Installed } from '../lib/plugins/runtime'
import type { Extension } from '../lib/plugins/validate'

const TYPE_WORDS: Record<string, string> = { movie: 'Movies', series: 'Series', channel: 'Channels', tv: 'TV', anime: 'Anime', other: 'Other' }
// Inline, so this section adds nothing to styles.css.
const LOGO = { width: '28px', height: '28px', flex: 'none', borderRadius: '6px', objectFit: 'contain', display: 'grid', placeItems: 'center', background: 'var(--surface-2)' }
const GRID = { display: 'grid', gap: '8px' }
const ROW = { padding: '8px 0' }
const WRAP = { overflowWrap: 'anywhere' }

const provides = (e: Extension) => (e.types?.length ? e.types.map((t) => TYPE_WORDS[t] ?? t).join(', ') : 'Not listed')

function Logo({ e }: { e: Extension }) {
  const [bad, setBad] = useState(false)
  return e.logo && !bad ? <img class="ext-logo" style={LOGO} src={e.logo} alt="" width={28} height={28} loading="lazy" onError={() => setBad(true)} /> : <span class="ext-logo" style={LOGO}><Icon name="plug" size={18} /></span>
}

function ConfirmAdd({ e, busy, onAdd, onCancel }: { e: Extension; busy: boolean; onAdd: () => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  // Focus starts on Add; Escape cancels and Tab stays inside, before the app's Back handler sees either.
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const k = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (!busy) onCancel(); return }
      if (ev.key !== 'Tab') return
      const btns = [...(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const i = btns.indexOf(document.activeElement as HTMLButtonElement)
      ev.preventDefault()
      btns[(i + (ev.shiftKey ? -1 : 1) + btns.length) % btns.length]?.focus()
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [busy])
  return (
    <div class="sheet-back" role="dialog" aria-modal="true" aria-label={`Add ${e.name}`}>
      <div class="sheet panel" ref={box}>
        <h3>Add {e.name}?</h3>
        <div class="facts-list">
          <div><span class="dim">Provides</span> {provides(e)}</div>
          <div><span class="dim">Host</span> {hostOf(e.url)}</div>
          <div><span class="dim">Address</span> <span class="small ext-url" style={WRAP}>{maskUrl(e.url)}</span></div>
        </div>
        {e.description && <p class="small">{e.description}</p>}
        <p class="small dim">Add only addons you trust: Flick asks {hostOf(e.url)} for titles and streams once it is added.</p>
        <div class="row">
          <button class="btn primary" onClick={onAdd} disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
          <button class="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** The Addons section of a plugin's page, in its own panel; nothing for a plugin without addons or one that is off. */
export function ExtensionsSection({ p }: { p: Installed }) {
  return hasExtensions(p) && p.enabled ? <section class="panel"><Addons p={p} /></section> : null
}

function Addons({ p }: { p: Installed }) {
  const [list, setList] = useState<Extension[] | null>(null)
  const [err, setErr] = useState('')
  const [addr, setAddr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ e: Extension; typed: boolean } | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Extension[] | null>(null)

  const load = async () => {
    try { setList(await listExtensions(p)); setErr('') } catch (e) { setErr((e as Error).message); setList([]) }
  }
  // Reload when the saved settings change, so a remove in the settings form shows here too.
  useEffect(() => { void load() }, [p.id, JSON.stringify(p.settings)])
  useEffect(() => {
    if (!browsing) return
    let live = true
    const t = setTimeout(() => {
      browseExtensions(p, query).then((r) => { if (live) setFound(r) }, (e) => { if (live) { setFound([]); notify((e as Error).message, 6000) } })
    }, query ? 300 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [browsing, query, p.id])

  const read = async (ev: Event) => {
    ev.preventDefault()
    setBusy(true)
    try { setConfirm({ e: await inspectExtension(p, addr), typed: true }) } catch (e) { notify((e as Error).message, 6000) }
    setBusy(false)
  }
  const add = async () => {
    if (!confirm) return
    const { e, typed } = confirm
    setBusy(true)
    try {
      const r = await addExtension(p, e.url)
      notify(r.message ?? (r.ok ? `Added ${e.name}.` : `Could not add ${e.name}.`), 6000)
      if (r.ok) {
        setConfirm(null)
        if (typed) setAddr('')
        await load()
      }
    } catch (e) { notify((e as Error).message, 6000) }
    setBusy(false)
  }
  const drop = async (e: Extension) => {
    if (!window.confirm(`Remove ${e.name} from ${p.manifest.name}?`)) return
    try {
      const r = await removeExtension(p, e.id)
      notify(r.message ?? (r.ok ? `Removed ${e.name}.` : `Could not remove ${e.name}.`), 6000)
      if (r.ok) await load()
    } catch (er) { notify((er as Error).message, 6000) }
  }

  return (
    <div class="ext" style={GRID} role="region" aria-label="Addons">
      <h3 style={{ margin: 0 }}>Addons</h3>
      {list === null && <p class="small dim">Loading addons…</p>}
      {err && <p class="err">{err}</p>}
      {list?.length === 0 && !err && <p class="small dim">No addons yet.</p>}
      {list?.map((e) => (
        <div class="list-row ext-row" style={ROW} key={e.id}>
          <Logo e={e} />
          <div class="grow">
            <div>{e.name}</div>
            <div class="small dim ext-url" style={WRAP}>{provides(e)} · {maskUrl(e.url)}</div>
          </div>
          {e.removable ? <button class="btn ghost sm" onClick={() => drop(e)} aria-label={`Remove ${e.name}`}>Remove</button> : <span class="small dim">Built in</span>}
        </div>
      ))}
      <form class="url-form" style={{ marginBottom: 0 }} onSubmit={read}>
        <Icon name="link" size={16} />
        <input value={addr} onInput={(ev) => setAddr((ev.target as HTMLInputElement).value)} placeholder="https://…/manifest.json or stremio://…" aria-label="Addon address" />
        <button class="btn" disabled={busy || !addr.trim()}>{busy && !confirm ? 'Reading…' : 'Add'}</button>
      </form>
      <button class="btn ghost sm" onClick={() => setBrowsing(!browsing)} aria-expanded={browsing}><Icon name="search" size={16} /> {browsing ? 'Close browse' : 'Browse addons'}</button>
      {browsing && (
        <div class="ext-browse" style={{ display: 'grid', gap: '4px' }}>
          <input type="search" value={query} onInput={(ev) => setQuery((ev.target as HTMLInputElement).value)} placeholder="Search addons" aria-label="Search addons" />
          {found === null && <p class="small dim">Loading the addon catalog…</p>}
          {found?.length === 0 && <p class="small dim">No addons match.</p>}
          {found?.map((e) => (
            <div class="list-row ext-row" style={ROW} key={e.id}>
              <Logo e={e} />
              <div class="grow">
                <div>{e.name}</div>
                <div class="small dim">{provides(e)} · {hostOf(e.url)}</div>
              </div>
              {/* Added from the list above, so a remove or an add there shows here at once. */}
              {list?.some((m) => m.id === e.id || m.url === e.url) ? <span class="small dim">Added</span> : <button class="btn sm" onClick={() => setConfirm({ e, typed: false })} aria-label={`Add ${e.name}`}>Add</button>}
            </div>
          ))}
        </div>
      )}
      {confirm && <ConfirmAdd e={confirm.e} busy={busy} onAdd={add} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
