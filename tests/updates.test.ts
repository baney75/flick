// P5, one update channel: the rules behind the update check, banner and plugin refresh.
import { describe, it, expect } from 'vitest'
import * as U from '../src/lib/updates'

const H = 60 * 60 * 1000

describe('update rules', () => {
  it('only the desktop apps self-update; the website and phones do not', () => {
    expect(U.updaterEnabled(true, false)).toBe(true)
    expect(U.updaterEnabled(true, true)).toBe(false)
    expect(U.updaterEnabled(false, false)).toBe(false)
  })

  it('is due again 24 hours after the last check, not before', () => {
    expect(U.isDue(23 * H, 0)).toBe(false)
    expect(U.isDue(24 * H, 0)).toBe(true)
    expect(U.isDue(0, 24 * H)).toBe(true)
  })

  it('every check result stamps the last check; only a download makes an update ready', () => {
    const s = { ...U.initial, lastCheck: 1, lastVersion: '0.1.0' }
    const ready = U.afterCheck(s, { kind: 'ready', version: '0.2.0' }, 5)
    expect([ready.lastCheck, ready.ready, ready.lastVersion]).toEqual([5, '0.2.0', '0.1.0'])
    const same = U.afterCheck(s, { kind: 'current' }, 5)
    expect([same.lastCheck, same.ready, same.status]).toEqual([5, null, 'Flick is up to date.'])
    const offline = U.afterCheck(s, { kind: 'failed', error: new Error('x'), online: false }, 5)
    expect([offline.lastCheck, offline.ready, offline.status]).toEqual([5, null, 'Could not reach GitHub. Flick tries again in 24 hours.'])
    const bad = U.afterCheck(s, { kind: 'failed', error: new Error('signature verification failed'), online: true }, 5)
    expect([bad.lastCheck, bad.ready, bad.status]).toEqual([5, null, 'The update check failed: signature verification failed'])
  })

  it('treats network errors and navigator offline as offline, other errors not', () => {
    expect(U.isOffline(new Error('x'), false)).toBe(true)
    expect(U.isOffline(new Error('error sending request for url (https://github.com/...)'), true)).toBe(true)
    expect(U.isOffline(new Error('dns error: failed to lookup address'), true)).toBe(true)
    expect(U.isOffline(new Error('signature verification failed'), true)).toBe(false)
  })

  it('refreshes official plugins on the first launch of a new app version only', () => {
    expect(U.forcePlugins('0.1.0', '0.2.0')).toBe(true)
    expect(U.forcePlugins('0.2.0', '0.2.0')).toBe(false)
  })

  it('names plugins whose update newly waits for permission', () => {
    const p = (id: string, pending?: object) => ({ id, pending, manifest: { name: id.toUpperCase() } })
    expect(U.newlyPending([p('a'), p('b', {})], [p('a', {}), p('b', {}), p('c')])).toEqual(['A'])
  })

  it('banner text and the playback wait', () => {
    expect(U.bannerText('0.2.0')).toBe('Flick 0.2.0 is ready. Restart to update.')
    expect(U.showBanner('0.2.0', false)).toBe(true)
    expect(U.showBanner('0.2.0', true)).toBe(false)
    expect(U.showBanner(null, false)).toBe(false)
  })
})
