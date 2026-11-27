import { useEffect, useRef, useState } from 'preact/hooks'
import { notify, reloadItems, items } from '../lib/store'
import * as Srv from '../lib/servers'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'

/** Servers live in Settings, as its first panel. `#/servers` scrolls here. */
export function ServersPanel() {
  const [list, setList] = useState<Srv.Server[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [here, setHere] = useState<Srv.FlickInfo | null>(null)
  const refresh = () => Srv.getServers().then(setList)
  useEffect(() => { refresh(); Srv.sameOriginFlick().then(setHere) }, [])

  const sync = async (s: Srv.Server) => {
    setBusy(s.id)
    try {
      const n = await Srv.syncServer(s)
      await reloadItems()
      notify(`${s.name}: ${n} items in your library.`)
    } catch (e) {
      notify(`${s.name}: ${(e as Error).message}`)
    }
    setBusy(null)
  }
  const add = async (s: Srv.Server) => {
    await Srv.saveServer(s)
    await refresh()
    await sync(s)
  }

  return (
    <section class="panel servers-panel" id="servers">
      <h3>Servers</h3>
      <p class="dim small">Connect a media server and everything on it joins your Flick library, searchable next to your own files.</p>

      {list.length > 0 && (
        <div class="connected">
          <h4 class="small dim">Connected</h4>
          {list.map((s) => (
            <div class="list-row">
              <Icon name="server" size={18} />
              <div class="grow">
                <div>{s.name} <span class="small dim">{s.type === 'plex' ? 'Plex' : s.type === 'kodi' ? 'Kodi' : s.type === 'flick' ? 'Flick server' : 'Jellyfin'}</span></div>
                <div class="small dim">{s.url} · {items.value.filter((i) => i.server === s.id).length} items</div>
              </div>
              <button class="btn ghost sm" onClick={() => sync(s)} disabled={busy === s.id}><Icon name="refresh" size={14} /> {busy === s.id ? 'Syncing' : 'Sync'}</button>
              <button class="btn ghost sm" onClick={async () => { await Srv.removeServer(s); await refresh(); await reloadItems() }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div class="server-grid">
        <FlickForm onAdd={add} here={here} />
        <JellyfinForm onAdd={add} />
        <PlexForm onAdd={add} />
        {isDesktop && <KodiForm onAdd={add} />}
      </div>
      {!isDesktop && <p class="small dim">Kodi works in the Flick apps.</p>}
      <p class="small dim">Flick talks to your server directly from this device. If the website cannot reach a server on your home network, use the desktop app, or put the server behind HTTPS.</p>
    </section>
  )
}

export function JellyfinForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => void; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { onAdd(await Srv.jellyfinLogin(url, user, pw)); setPw('') } catch (e2) { setErr((e2 as Error).message) }
    setBusy(false)
  }
  return (
    <form class="panel" onSubmit={submit}>
      {heading && <h3>Jellyfin or Emby</h3>}
      <label>Server address<input required placeholder="http://192.168.1.20:8096" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>
      <label>Username<input required autocomplete="username" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} /></label>
      <label>Password<input type="password" autocomplete="current-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></label>
      <button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {err && <p class="err">{err}</p>}
    </form>
  )
}

export function FlickForm({ onAdd, here, heading = true }: { onAdd: (s: Srv.Server) => void; here: Srv.FlickInfo | null; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { onAdd(await Srv.flickConnect(here ? location.origin : url, code)); setCode('') } catch (e2) { setErr((e2 as Error).message) }
    setBusy(false)
  }
  return (
    <form class="panel" onSubmit={submit}>
      {heading && <h3>Flick server (NAS)</h3>}
      {here
        ? <p class="dim small">This page comes from the Flick server {here.name}. Enter the access code it printed.</p>
        : <p class="dim small">Run flick-server on the computer or NAS that holds your media. It prints a setup link; open that on this device, or paste the address and code here.</p>}
      {!here && <label>Address<input required placeholder="https://nas.tail1234.ts.net" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>}
      <label>Access code<input required autocomplete="off" spellcheck={false} value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} /></label>
      <button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {busy && !here && Srv.needsLocalNetwork(url) && <p class="small dim">{Srv.LOCAL_NETWORK_HINT}</p>}
      {err && <p class="err">{err}</p>}
    </form>
  )
}

export function KodiForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => void; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { onAdd(await Srv.kodiConnect(url, user, pw)); setPw('') } catch (e2) { setErr((e2 as Error).message) }
    setBusy(false)
  }
  return (
    <form class="panel" onSubmit={submit}>
      {heading && <h3>Kodi</h3>}
      <p class="dim small">In Kodi, turn on Settings, Services, Control, Allow remote control via HTTP. Flick plays files straight from Kodi. MKV and AVI files play after a quick convert in the Mac, Windows and Linux apps.</p>
      <label>Kodi address<input required placeholder="http://192.168.1.30:8080" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>
      <label>Username<input autocomplete="username" placeholder="Empty if Kodi has no password" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} /></label>
      <label>Password<input type="password" autocomplete="current-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></label>
      <button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {err && <p class="err">{err}</p>}
    </form>
  )
}

export function PlexForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => void; heading?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const abort = useRef<AbortController | null>(null)

  const signIn = async () => {
    setBusy(true)
    setErr(null)
    abort.current = new AbortController()
    const win = window.open('about:blank', '_blank', 'width=520,height=720')
    try {
      const tok = await Srv.plexPinLogin((link) => { if (win) win.location.href = link; else window.open(link, '_blank') }, abort.current.signal)
      win?.close()
      const servers = await Srv.plexServers(tok)
      if (!servers.length) throw new Error('Signed in, but no Plex server answered from this device.')
      for (const s of servers) onAdd(s)
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }
  const submitManual = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { onAdd(await Srv.plexManual(url, token)) } catch (e2) { setErr((e2 as Error).message) }
    setBusy(false)
  }
  return (
    <div class="panel">
      {heading && <h3>Plex</h3>}
      <p class="dim small">Sign in on plex.tv and approve Flick. Flick finds your servers on its own.</p>
      <div class="row">
        <button class="btn primary" onClick={signIn} disabled={busy}>{busy ? 'Waiting for Plex…' : 'Sign in with Plex'}</button>
        {busy && <button class="btn ghost" onClick={() => abort.current?.abort()}>Cancel</button>}
      </div>
      <button class="link-btn" onClick={() => setManual(!manual)}>{manual ? 'Hide' : 'Use a server address and token instead'}</button>
      {manual && (
        <form onSubmit={submitManual}>
          <label>Server address<input required placeholder="http://192.168.1.20:32400" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>
          <label>X-Plex-Token<input required value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} /></label>
          <button class="btn" disabled={busy}>Connect</button>
        </form>
      )}
      {err && <p class="err">{err}</p>}
    </div>
  )
}
