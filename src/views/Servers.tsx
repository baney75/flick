import { useEffect, useRef, useState } from 'preact/hooks'
import { notify, reloadItems, items } from '../lib/store'
import * as Srv from '../lib/servers'
import { Icon } from '../components/icons'
import { isDesktop } from '../lib/platform'

export function JellyfinForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => Promise<void> | void; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { await onAdd(await Srv.jellyfinLogin(url, user, pw)); setPw('') } catch (e2) { setErr((e2 as Error).message) }
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

export function FlickForm({ onAdd, here, heading = true }: { onAdd: (s: Srv.Server) => Promise<void> | void; here: Srv.FlickInfo | null; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { await onAdd(await Srv.flickConnect(here ? location.origin : url, code)); setCode('') } catch (e2) { setErr((e2 as Error).message) }
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

export function KodiForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => Promise<void> | void; heading?: boolean }) {
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { await onAdd(await Srv.kodiConnect(url, user, pw)); setPw('') } catch (e2) { setErr((e2 as Error).message) }
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

export function PlexForm({ onAdd, heading = true }: { onAdd: (s: Srv.Server) => Promise<void> | void; heading?: boolean }) {
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
      for (const s of servers) await onAdd(s)
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }
  const submitManual = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try { await onAdd(await Srv.plexManual(url, token)) } catch (e2) { setErr((e2 as Error).message) }
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
