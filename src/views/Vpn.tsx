import { useEffect, useState } from 'preact/hooks'
import { isDesktop, isMobileApp, invoke, onDesktopEvent } from '../lib/platform'
import { speedTest, speedLabel, type SpeedResult } from '../lib/speed'

/** The VPN gate's state (the `vpn_gate` command and the `vpn-gate` event). */
export interface Gate { ok: boolean; iface?: string | null; exit?: string | null; message?: string | null }

export const DESKTOP_ONLY = 'Torrents play in the Flick desktop app with a VPN on.'
const KEY = 'flick.speedTest'

export function gateLine(g: Gate | null): string {
  if (!g) return 'Checking for a VPN.'
  if (!g.ok) return g.message || 'Turn on your VPN to play torrents.'
  return `Protected by ${g.iface || 'your VPN'}${g.exit ? `, leaving from ${g.exit}` : ''}.`
}

function lastResult(): SpeedResult | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null }
}

/** Settings > Privacy: the gate's state and the speed test (spec rule 32). */
export function VpnPanel() {
  const [gate, setGate] = useState<Gate | null>(null)
  const [last, setLast] = useState(lastResult)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const check = (force = false) =>
    invoke<Gate>('vpn_gate', { force }).then((g) => { setGate(g); return g }, (e) => {
      const g = { ok: false, message: String(e) }
      setGate(g)
      return g
    })
  useEffect(() => {
    if (!isDesktop || isMobileApp) return
    check()
    let off: (() => void) | undefined
    let gone = false
    onDesktopEvent<Gate>('vpn-gate', setGate).then((f) => { if (gone) f(); else off = f }, () => {})
    return () => { gone = true; off?.() }
  }, [])
  if (!isDesktop || isMobileApp) return <p class="dim small">{DESKTOP_ONLY}</p>
  const test = async () => {
    setRunning(true)
    setErr('')
    try {
      const r = await speedTest((await check(true)).ok)
      setLast(r)
      try { localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* private mode */ }
    } catch (e) {
      setErr(`The speed test didn't finish: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }
  return (
    <div>
      <p class="small">{gateLine(gate)}</p>
      <div class="row">
        <button class="btn" onClick={() => check(true)}>Check again</button>
        <button class="btn" onClick={test} disabled={running}>{running ? 'Testing speed' : 'Test speed'}</button>
      </div>
      <p class="dim small">Test speed downloads up to 25 MB from Cloudflare (speed.cloudflare.com) when you press it.</p>
      {last && <p class="small">{speedLabel(last)} <span class="dim">· tested {new Date(last.at).toLocaleString()}</span></p>}
      {err && <p class="err">{err}</p>}
    </div>
  )
}
