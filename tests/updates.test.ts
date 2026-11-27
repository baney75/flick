// P5, one update channel: every case in the spec's table that is Flick's own logic.
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// The wiring, with the Tauri updater, the plugin registry and the store faked.
const fake = vi.hoisted(() => ({
  check: vi.fn(),
  checkUpdates: vi.fn(),
  notify: vi.fn(),
  relaunch: vi.fn(),
  desktop: true,
}))
vi.mock('../src/lib/platform', () => ({ get isDesktop() { return fake.desktop }, isMobileApp: false }))
vi.mock('../src/lib/store', async () => {
  const { signal } = await vi.importActual<typeof import('@preact/signals')>('@preact/signals')
  return { notify: fake.notify, nowPlaying: signal(null), route: signal('/') }
})
vi.mock('../src/lib/plugins/registry', async () => {
  const { signal } = await vi.importActual<typeof import('@preact/signals')>('@preact/signals')
  return { installed: signal([]), checkUpdates: fake.checkUpdates }
})
vi.mock('@tauri-apps/plugin-updater', () => ({ check: fake.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: fake.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }))

async function fresh() {
  vi.resetModules()
  const up = await import('../src/lib/updater')
  const store = await import('../src/lib/store')
  const reg = await import('../src/lib/plugins/registry')
  return { up, store: store as unknown as { nowPlaying: { value: unknown } }, reg: reg as unknown as { installed: { value: unknown[] } } }
}
const release = (version: string, over: Record<string, unknown> = {}) => ({ version, download: vi.fn(async () => {}), install: vi.fn(async () => {}), close: vi.fn(async () => {}), ...over })

describe('the one update check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.desktop = true
    fake.checkUpdates.mockResolvedValue([])
  })

  it('newer release published: downloads once, then the banner says it is ready', async () => {
    const { up } = await fresh()
    const r = release('0.2.0')
    fake.check.mockResolvedValue(r)
    await up.runCheck()
    expect(r.download).toHaveBeenCalledTimes(1)
    expect(r.install).not.toHaveBeenCalled()
    expect(up.updates.value.ready).toBe('0.2.0')
    expect(U.showBanner(up.updates.value.ready, up.playing.value)).toBe(true)
    const again = release('0.2.0')
    fake.check.mockResolvedValue(again)
    await up.runCheck()
    expect(again.download).not.toHaveBeenCalled()
    expect(again.close).toHaveBeenCalledTimes(1)
  })

  it('the same check runs the plugin update check', async () => {
    const { up } = await fresh()
    fake.check.mockResolvedValue(null)
    await up.runCheck()
    expect(fake.check).toHaveBeenCalledTimes(1)
    expect(fake.checkUpdates).toHaveBeenCalledTimes(1)
  })

  it('same version: nothing shown, last check time updates', async () => {
    const { up } = await fresh()
    fake.check.mockResolvedValue(null)
    const t0 = Date.now()
    await up.runCheck()
    expect(up.updates.value.ready).toBeNull()
    expect(up.updates.value.lastCheck).toBeGreaterThanOrEqual(t0)
    expect(up.updates.value.status).toBe('Flick is up to date.')
    expect(fake.notify).not.toHaveBeenCalled()
  })

  it('offline: no banner, no toast, next check in 24 hours', async () => {
    const { up } = await fresh()
    fake.check.mockRejectedValue(new Error('error sending request for url'))
    fake.checkUpdates.mockResolvedValue(['Films: update check failed, network error'])
    await up.runCheck()
    const s = up.updates.value
    expect(s.ready).toBeNull()
    expect(fake.notify).not.toHaveBeenCalled()
    expect(U.isDue(s.lastCheck + 23 * H, s.lastCheck)).toBe(false)
    expect(U.isDue(s.lastCheck + 24 * H, s.lastCheck)).toBe(true)
  })

  it('video playing when the update is ready: the banner waits and Restart does nothing', async () => {
    const { up, store } = await fresh()
    const r = release('0.2.0')
    fake.check.mockResolvedValue(r)
    store.nowPlaying.value = { key: 'x' }
    await up.runCheck()
    expect(U.showBanner(up.updates.value.ready, up.playing.value)).toBe(false)
    await up.restartToUpdate()
    expect(r.install).not.toHaveBeenCalled()
    store.nowPlaying.value = null
    expect(U.showBanner(up.updates.value.ready, up.playing.value)).toBe(true)
    await up.restartToUpdate()
    expect(r.install).toHaveBeenCalledTimes(1)
    expect(fake.relaunch).toHaveBeenCalledTimes(1)
  })

  it('plugin update with new permissions: one toast pointing at the Updates panel', async () => {
    const { up, reg } = await fresh()
    fake.check.mockResolvedValue(null)
    fake.checkUpdates.mockImplementation(async () => {
      reg.installed.value = [{ id: 'films', manifest: { name: 'Films' }, pending: { added: ['reach new.example'] } }]
      return ['Films has an update that asks to reach new.example.']
    })
    await up.runCheck()
    expect(fake.notify).toHaveBeenCalledTimes(1)
    expect(fake.notify.mock.calls[0][0]).toMatch(/^Films has an update .*Settings, Updates/)
  })

  it('tampered update: the refused download leaves no banner and nothing to install', async () => {
    const { up } = await fresh()
    const r = release('0.2.0', { download: vi.fn(async () => { throw new Error('signature verification failed') }) })
    fake.check.mockResolvedValue(r)
    await up.runCheck()
    expect(up.updates.value.ready).toBeNull()
    expect(up.updates.value.status).toMatch(/signature verification failed/)
    await up.restartToUpdate()
    expect(r.install).not.toHaveBeenCalled()
  })

  it('a newer release after an earlier download: the earlier one is closed, the newer one installs', async () => {
    const { up } = await fresh()
    const first = release('0.2.0')
    fake.check.mockResolvedValue(first)
    await up.runCheck()
    const next = release('0.3.0')
    fake.check.mockResolvedValue(next)
    await up.runCheck()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(next.close).not.toHaveBeenCalled()
    expect(up.updates.value.ready).toBe('0.3.0')
    await up.restartToUpdate()
    expect(next.install).toHaveBeenCalledTimes(1)
    expect(first.install).not.toHaveBeenCalled()
  })

  it('a newer release that fails to download is closed; the earlier download still installs', async () => {
    const { up } = await fresh()
    const first = release('0.2.0')
    fake.check.mockResolvedValue(first)
    await up.runCheck()
    const bad = release('0.3.0', { download: vi.fn(async () => { throw new Error('signature verification failed') }) })
    fake.check.mockResolvedValue(bad)
    await up.runCheck()
    expect(bad.close).toHaveBeenCalledTimes(1)
    expect(first.close).not.toHaveBeenCalled()
    expect(up.updates.value.ready).toBe('0.2.0')
    await up.restartToUpdate()
    expect(first.install).toHaveBeenCalledTimes(1)
  })

  it('a new app version forces the plugin check once; Check now always does', async () => {
    const { up } = await fresh()
    fake.check.mockResolvedValue(null)
    await up.runCheck()
    expect(fake.checkUpdates.mock.calls[0][2]).toBe(true)
    await up.runCheck()
    expect(fake.checkUpdates.mock.calls[1][2]).toBe(false)
    await up.runCheck(true)
    expect(fake.checkUpdates.mock.calls[2][2]).toBe(true)
  })

  it('Check now pressed during the launch check still forces the plugin check', async () => {
    const { up } = await fresh()
    let finish = () => {}
    fake.check.mockReturnValueOnce(new Promise((ok) => { finish = () => ok(null) })).mockResolvedValue(null)
    const auto = up.runCheck()
    const manual = up.runCheck(true)
    await Promise.resolve()
    finish()
    await Promise.all([auto, manual])
    expect(fake.checkUpdates).toHaveBeenCalledTimes(2)
    expect(fake.checkUpdates.mock.calls[1][2]).toBe(true)
  })

  it('the website never loads the app updater', async () => {
    fake.desktop = false
    const { up } = await fresh()
    await up.runCheck()
    expect(fake.check).not.toHaveBeenCalled()
    expect(fake.checkUpdates).toHaveBeenCalledTimes(1)
    expect(up.updates.value.ready).toBeNull()
  })
})
