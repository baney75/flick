import { useEffect, useRef, useState } from 'preact/hooks'
import { notify, reloadItems, items } from '../lib/store'
import * as Srv from '../lib/servers'
import { Icon } from '../components/icons'

export function Servers() {
  const [list, setList] = useState<Srv.Server[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = () => Srv.getServers().then(setList)
  useEffect(() => { refresh() }, [])

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
    <div class="page">
      <header class="page-head"><h1>Servers</h1></header>
      <p class="dim lead">Connect a media server and everything on it joins your Flick library, searchable next to your own files.</p>

      {list.length > 0 && (
        <div class="panel">
          <h3>Connected</h3>
          {list.map((s) => (
            <div class="list-row">
              <Icon name="server" size={18} />
              <div class="grow">
                <div>{s.name} <span class="small dim">{s.type === 'plex' ? 'Plex' : 'Jellyfin'}</span></div>
                <div class="small dim">{s.url} · {items.value.filter((i) => i.server === s.id).length} items</div>
              </div>
              <button class="btn ghost sm" onClick={() => sync(s)} disabled={busy === s.id}><Icon name="refresh" size={14} /> {busy === s.id ? 'Syncing' : 'Sync'}</button>
              <button class="btn ghost sm" onClick={async () => { await Srv.removeServer(s); await refresh(); await reloadItems() }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div class="server-grid">
        <JellyfinForm onAdd={add} />
        <PlexForm onAdd={add} />
      </div>
      <p class="small dim">Flick talks to your server directly from this device. If the website cannot reach a server on your home network, use the desktop app, or put the server behind HTTPS.</p>
    </div>
  )
}

function JellyfinForm({ onAdd }: { onAdd: (s: Srv.Server) => void }) {
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
      <h3>Jellyfin or Emby</h3>
      <label>Server address<input required placeholder="http://192.168.1.20:8096" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /></label>
      <label>Username<input required autocomplete="username" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} /></label>
      <label>Password<input type="password" autocomplete="current-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></label>
      <button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {err && <p class="err">{err}</p>}
    </form>
  )
}

function PlexForm({ onAdd }: { onAdd: (s: Srv.Server) => void }) {
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
      <h3>Plex</h3>
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
