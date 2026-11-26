// Settings > Playback: the languages and quality Play picks by, and what this device shows.
import { useEffect, useState } from 'preact/hooks'
import { settings, setSettings } from '../lib/store'
import { LANGS } from '../lib/prefs'
import { langName, type Device, type MaxQuality } from '../lib/pick'
import { deviceLine, readDevice } from '../lib/device'

/** An ordered language list: the first is the one Play looks for first. */
function LangList({ label, value, set, empty }: { label: string; value: string[]; set: (v: string[]) => void; empty: string }) {
  const move = (i: number) => set([...value.slice(0, i - 1), value[i], value[i - 1], ...value.slice(i + 1)])
  return (
    <div class="lang-list" role="group" aria-label={label}>
      <h4 class="small dim">{label}</h4>
      {!value.length && <p class="small dim">{empty}</p>}
      {value.map((l, i) => (
        <div class="list-row" key={l}>
          <span class="grow">{i + 1}. {langName(l)}</span>
          <button class="btn ghost sm" disabled={i === 0} onClick={() => move(i)} aria-label={`Move ${langName(l)} up`}>Move up</button>
          <button class="btn ghost sm" onClick={() => set(value.filter((x) => x !== l))} aria-label={`Remove ${langName(l)}`}>Remove</button>
        </div>
      ))}
      <select value="" aria-label={`Add to ${label}`} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) set([...value, v]) }}>
        <option value="">Add a language</option>
        {LANGS.filter((l) => !value.includes(l)).map((l) => <option value={l}>{langName(l)}</option>)}
      </select>
    </div>
  )
}

const QUALITY: [MaxQuality, string][] = [['4K', 'Best for this device'], ['1080p', '1080p'], ['720p', '720p'], ['SD', 'Data saver']]

export function StreamPrefs() {
  const s = settings.value
  const [dev, setDev] = useState<Device | null>(null)
  useEffect(() => { readDevice().then(setDev).catch(() => {}) }, [])
  return (
    <>
      <LangList label="Audio language" value={s.audio} set={(audio) => setSettings({ audio })} empty="Play takes any language." />
      <LangList label="Subtitle language" value={s.subs} set={(subs) => setSettings({ subs })} empty="Subtitles stay off unless you turn them on." />
      <label>Quality
        <select value={s.maxQuality} onChange={(e) => setSettings({ maxQuality: (e.target as HTMLSelectElement).value as MaxQuality })}>
          {QUALITY.map(([v, l]) => <option value={v}>{l}</option>)}
        </select>
      </label>
      {dev && <p class="small dim" data-device>{deviceLine(dev)}</p>}
    </>
  )
}
