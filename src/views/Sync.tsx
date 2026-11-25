import { useMemo, useState } from 'preact/hooks'
import { renderSVG } from 'uqr'
import { sync, createGroup, join, leave, rename } from '../lib/sync/engine'
import { pairLink, parsePair } from '../lib/sync/crypto'
import { go, notify } from '../lib/store'
import { Icon } from '../components/icons'

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

export function SyncPanel() {
  const s = sync.value
  const [code, setCode] = useState('')
  const [show, setShow] = useState(false)
  const link = s.secret ? pairLink(s.secret) : ''
  const qr = useMemo(() => (link && show ? renderSVG(link, { border: 2 }) : ''), [link, show])

  const joinCode = async () => {
    const k = parsePair(code)
    if (!k) return notify('That is not a Flick pairing link or code.')
    await join(k)
    setCode('')
    notify('Joined. Your devices sync while Flick is open on them.')
  }

  if (!s.paired) {
    return (
      <section class="panel">
        <h3>Sync across devices</h3>
        <p class="dim small">Watch progress, servers, addons and settings follow you between your devices. Data goes device to device sealed with a key only your devices hold.</p>
        <div class="row">
          <button class="btn primary" onClick={async () => { await createGroup(); setShow(true) }}><Icon name="plus" size={16} /> Start sync on this device</button>
        </div>
        <label>Or join with a link or code from your other device
          <div class="row">
            <input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="Paste a pairing link" aria-label="Pairing link or code" />
            <button class="btn" onClick={joinCode} disabled={!code.trim()}>Join</button>
          </div>
        </label>
      </section>
    )
  }

  const others = s.peers.filter((p) => p.id !== s.device).sort((a, b) => Number(b.online) - Number(a.online) || b.seen - a.seen)
  return (
    <section class="panel">
      <div class="panel-head">
        <h3>Sync across devices</h3>
        <span class={`small ${s.status === 'online' ? 'ok' : 'dim'}`}>{s.status === 'online' ? 'Connected' : s.status === 'connecting' ? 'Connecting…' : 'Offline, will retry'}</span>
      </div>
      <label>This device
        <input value={s.name} onChange={(e) => rename((e.target as HTMLInputElement).value)} aria-label="This device's name" />
      </label>
      {others.length === 0 && <p class="dim small">No other devices yet. Add one below.</p>}
      {others.map((p) => (
        <div class="list-row">
          <Icon name="server" size={16} />
          <div class="grow"><div>{p.name}</div><div class="small dim">{p.online ? 'Online now' : `Seen ${ago(p.seen)}`}</div></div>
        </div>
      ))}
      <div class="row">
        <button class="btn" onClick={() => setShow(!show)} aria-expanded={show}>{show ? 'Hide pairing code' : 'Add a device'}</button>
        <button class="btn ghost" onClick={async () => {
          if (!confirm('Stop syncing this device? Your library here stays as it is.')) return
          await leave()
          notify('This device left sync.')
        }}>Leave sync</button>
      </div>
      {show && (
        <div class="pair">
          <div class="qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="Pairing QR code" />
          <div class="grow">
            <p class="small">Scan this with your phone's camera, or open the link on your other device. Anyone with this code can join your sync, so share it only with your own devices.</p>
            <button class="btn sm" onClick={() => navigator.clipboard.writeText(link).then(() => notify('Pairing link copied.'), () => prompt('Copy this pairing link', link))}>Copy link</button>
          </div>
        </div>
      )}
    </section>
  )
}

export function PairPage({ k }: { k: string | null }) {
  const secret = k ? parsePair(`?k=${k}`) : null
  const s = sync.value
  // Keep the code out of history and screenshots once it is read.
  if (secret) history.replaceState(null, '', '#/pair')
  if (!secret && !s.paired) return <div class="page narrow"><p class="dim">This pairing link is not complete. Open Add a device on your other device and try again.</p></div>
  if (!secret) return <div class="page narrow"><SyncPanel /></div>
  const same = s.secret === secret
  return (
    <div class="page narrow">
      <header class="page-head"><h1>Sync this device</h1></header>
      <section class="panel">
        {same ? <p>This device is already in this sync group.</p> : (
          <>
            <p>Join this device to your Flick sync? Watch progress, servers, addons and settings will match your other devices.</p>
            {s.paired && <p class="small dim">This device is in another sync group now. Joining leaves that one.</p>}
            <div class="row">
              <button class="btn primary" onClick={async () => { await join(secret); notify('Joined.'); go('/settings') }}>Join</button>
              <button class="btn ghost" onClick={() => go('/')}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
