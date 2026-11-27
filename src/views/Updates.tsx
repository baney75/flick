import { useState } from 'preact/hooks'
import { installed, acceptUpdate } from '../lib/plugins/registry'
import { updates, version, appUpdates, playing, runCheck, restartToUpdate } from '../lib/updater'
import { isDesktop, isMobileApp } from '../lib/platform'
import { logTail } from '../lib/playlog'
import { notify } from '../lib/store'
import { showBanner, bannerText } from '../lib/updates'

/** Settings > Updates: the app and plugin updates in one place. */
export function UpdatesPanel() {
  const s = updates.value
  const waiting = installed.value.filter((p) => p.pending)
  const [busy, setBusy] = useState(false)
  const checkNow = async () => {
    setBusy(true)
    try { await runCheck(true) } finally { setBusy(false) }
  }
  const how = appUpdates
    ? 'New versions download in the background from Flick\'s releases on GitHub and install when you restart.'
    : isMobileApp ? 'This app updates through your device\'s app store.' : 'The website updates itself when you reload the page.'
  // SPEC-playback-2 rule 8: the playback log's last 200 lines, for Donovan to paste. Nothing is sent.
  const copyLog = async () => {
    const t = await logTail()
    if (!t) return notify('The playback log is empty.')
    navigator.clipboard.writeText(t).then(() => notify('Playback log copied.'), () => prompt('Copy the playback log', t))
  }
  return (
    <section class="panel" id="updates">
      <h3>Updates</h3>
      <p class="dim small">Flick {version.value}. {how}</p>
      <p class="small update-status">{s.lastCheck ? `Last checked ${new Date(s.lastCheck).toLocaleString()}.` : 'Not checked yet.'} {s.status}</p>
      <div class="row">
        <button class="btn" disabled={busy} onClick={checkNow}>{busy ? 'Checking…' : 'Check now'}</button>
        {appUpdates && s.ready && <button class="btn primary" onClick={restartToUpdate}>Restart to update</button>}
        {isDesktop && <button class="btn" onClick={copyLog}>Copy playback log</button>}
      </div>
      {waiting.map((p) => (
        <div class="list-row update-plugin">
          <span>{p.manifest.name} {p.pending!.manifest.version} asks to {p.pending!.added.join(', ')}.</span>
          <button class="btn sm" onClick={() => acceptUpdate(p.id).catch((e) => notify(`${p.manifest.name} did not update: ${(e as Error).message ?? e}`))}>Allow</button>
        </div>
      ))}
    </section>
  )
}

/** "Flick 0.2.0 is ready. Restart to update." Hidden while something plays. */
export function UpdateBanner() {
  const ready = updates.value.ready
  if (!appUpdates || !showBanner(ready, playing.value)) return null
  return (
    <div class="update-banner" role="status">
      <span>{bannerText(ready!)}</span>
      <button class="btn primary sm" onClick={restartToUpdate}>Restart</button>
    </div>
  )
}
