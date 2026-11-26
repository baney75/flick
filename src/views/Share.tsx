import { useMemo } from 'preact/hooks'
import { renderSVG } from 'uqr'
import { notify } from '../lib/store'
import { sharePrefs, shareStatus, shareBusy, applyShare, newShareCode, primaryLink, type SharePrefs } from '../lib/share'

const README = 'https://github.com/baney75/flick/blob/main/server/README.md'

export function SharePanel() {
  const p = sharePrefs.value
  const s = shareStatus.value
  const busy = shareBusy.value
  const link = s.on ? primaryLink(s.setup_links) : null
  const qr = useMemo(() => (link ? renderSVG(link.url, { border: 2 }) : ''), [link?.url])
  const toggle = (k: keyof SharePrefs) => (e: Event) => applyShare({ [k]: (e.target as HTMLInputElement).checked })
  const renew = async () => {
    if (!confirm('Make a new access code? Every connected device must reconnect with the new link.')) return
    try {
      await newShareCode()
      notify('New access code made. Reconnect your other devices with the new link.')
    } catch (e) {
      notify((e as Error).message ?? String(e))
    }
  }

  return (
    <section class="panel share">
      <h3>Share this library</h3>
      <p class="dim small">Watch the media on this computer from your phone, tablet or TV.</p>
      <label class="toggle"><input type="checkbox" checked={p.on} disabled={busy} onChange={toggle('on')} /> Share this library</label>
      <label class="toggle"><input type="checkbox" checked={p.lan} disabled={busy} onChange={toggle('lan')} /> Devices on my Wi-Fi</label>
      <label class="toggle"><input type="checkbox" checked={p.tailscale} disabled={busy} onChange={toggle('tailscale')} /> Tailscale</label>
      {s.on && s.tailscale_url && <p class="small">Tailscale address: {s.tailscale_url}</p>}
      {s.on && s.tailscale_error && <p class="small err" style="white-space: pre-wrap">{s.tailscale_error}</p>}
      {s.on && !p.lan && !p.tailscale && <p class="small dim">Turn on Wi-Fi or Tailscale so your other devices can reach this computer.</p>}
      {link && (
        <div class="pair">
          <div class="qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="Setup QR code" />
          <div class="grow">
            <p class="small">{link.label} link. Scan it on your other device, or open it there. Anyone with this link can watch your library, so share it only with your own devices.</p>
            <button class="btn sm" onClick={() => navigator.clipboard.writeText(link.url).then(() => notify('Setup link copied.'), () => prompt('Copy this setup link', link.url))}>Copy link</button>
          </div>
        </div>
      )}
      <div class="row">
        <button class="btn ghost sm" onClick={renew} disabled={busy}>New access code</button>
      </div>
      <p class="dim small">Sharing stops when Flick closes. For an always-on library, run flick-server on the computer or NAS.</p>
      <p class="dim small"><a href={README} target="_blank" rel="noreferrer">For access from anywhere without Tailscale, run flick-server with a Cloudflare tunnel</a></p>
    </section>
  )
}
