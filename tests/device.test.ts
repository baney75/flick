import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { detect, deviceLine, qualityForSide, type DeviceEnv } from '../src/lib/device'
import { defaultAudio, validPref } from '../src/lib/prefs'

// The store reads the route at import.
vi.hoisted(() => Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} }))
const { settingsFrom } = await import('../src/lib/store')

const env = (more: Partial<DeviceEnv> = {}): DeviceEnv => ({ screen: { width: 1920, height: 1080 }, dpr: 1, hdr: false, desktop: false, phone: false, ...more })

describe('device quality', () => {
  it('2560x1440 at DPR 1 is 1080p', () => expect(detect(env({ screen: { width: 2560, height: 1440 } })).maxQuality).toBe('1080p'))
  it('1512x982 at DPR 2 (3024 long side) is 4K', () => expect(detect(env({ screen: { width: 1512, height: 982 }, dpr: 2 })).maxQuality).toBe('4K'))
  it.each([[3000, '4K'], [2999, '1080p'], [1700, '1080p'], [1699, '720p'], [1100, '720p'], [1099, 'SD']])('%i px is %s', (px, q) =>
    expect(qualityForSide(px)).toBe(q))
  it('the desktop app counts an attached display the shell reports', () =>
    expect(detect(env({ screen: { width: 1440, height: 900 }, desktop: true, displays: [{ width: 2880, height: 1800 }, { width: 3840, height: 2160 }] })).maxQuality).toBe('4K'))
  it('a portrait phone uses its long side', () => expect(detect(env({ screen: { width: 390, height: 844 }, dpr: 3, phone: true })).maxQuality).toBe('1080p'))
})

describe('device codecs', () => {
  const probe = (yes: string[], no: string[]) => (t: string) => yes.some((c) => t.includes(c)) ? 'probably' : no.some((c) => t.includes(c)) ? '' : 'maybe'
  it('reads each codec from canPlayType: yes, no, or unknown', () =>
    expect(detect(env({ canPlay: probe(['avc1'], ['hvc1']) })).codecs).toEqual({ h264: true, hevc: false }))
  it('MediaSource yes wins; MediaSource no with a maybe tag stays unknown', () => {
    const d = detect(env({ mse: (t) => t.includes('av01'), canPlay: probe([], ['hvc1']) }))
    expect(d.codecs).toEqual({ av1: true, hevc: false })
  })
  it('nothing to ask: all unknown', () => expect(detect(env()).codecs).toEqual({}))
  it('reads HDR', () => expect(detect(env({ hdr: true })).hdr).toBe(true))
  it('says it in one line', () => {
    expect(deviceLine({ maxQuality: '1080p', hdr: false, codecs: { hevc: true, av1: true }, desktop: true, phone: false })).toBe('This device: 1080p, SDR, plays HEVC and AV1')
    expect(deviceLine({ maxQuality: '4K', hdr: true, codecs: { hevc: false }, desktop: false, phone: false })).toBe('This device: 4K, HDR')
  })
})

describe('stream preferences', () => {
  it('audio defaults to the device languages as base codes', () => expect(defaultAudio(['en-US', 'en-GB', 'fr-CA'])).toEqual(['en', 'fr']))
  it('adds English when absent', () => expect(defaultAudio(['de-DE', 'es'])).toEqual(['de', 'es', 'en']))
  it('settings saved before this change load the defaults', () => {
    const old = JSON.stringify({ autoplayNext: false, speed: 1.5, volume: 1, skipSeconds: 30, theme: 'dark', look: '', removeWatched: false })
    expect(settingsFrom(old, ['es-MX', 'en-US'])).toMatchObject({ skipSeconds: 30, audio: ['es', 'en'], subs: [], maxQuality: '4K' })
    expect(settingsFrom(null, [])).toMatchObject({ audio: ['en'], subs: [], maxQuality: '4K' })
  })
  it('saved preferences win over the defaults', () =>
    expect(settingsFrom(JSON.stringify({ audio: ['ja'], subs: ['en'], maxQuality: '720p' }), ['en'])).toMatchObject({ audio: ['ja'], subs: ['en'], maxQuality: '720p' }))
  it('a synced value of the wrong shape is skipped', () => {
    expect([validPref('audio', ['en', 'fr']), validPref('audio', 'en'), validPref('subs', [1]), validPref('maxQuality', '8K'), validPref('maxQuality', 'SD')])
      .toEqual([true, false, false, false, true])
  })
})
