// Addons inside a source plugin (SPEC-plugins-hub part C, rules 9 and 12): the contract's shapes and
// Flick's side of adding and removing. Every key here is made up.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.location ??= { hash: '' }
  g.addEventListener ??= () => {}
})
import * as V from '../src/lib/plugins/validate'
import * as E from '../src/lib/plugins/extensions'
import { redact, type Installed } from '../src/lib/plugins/runtime'
import hostJs from '../public/plugin-host.js?raw'

const FNS = ['catalog', 'meta', 'streams']
const manifest = (over: Record<string, unknown> = {}) => ({
  api: 1, id: 'org.example.addons', name: 'Addons', version: '1.0.0', hosts: ['*'],
  catalogs: [{ id: 'top', name: 'Top', type: 'movie' }],
  settings: [
    { key: 'addons', label: 'Extra addon URLs', type: 'list', default: [] },
    { key: 'token', label: 'Token', type: 'password' },
    { key: 'mode', label: 'Mode', type: 'select', options: ['a', 'b'] },
  ],
  ...over,
})
const row = (i: number, over: Record<string, unknown> = {}) => ({ id: `org.example.a${i}`, name: `Addon ${i}`, url: `https://a${i}.example.org/manifest.json`, removable: true, ...over })

describe('the extensions contract', () => {
  it('has.extensions is set only with all five functions', () => {
    expect(V.validateManifest(manifest(), FNS).has.extensions).toBe(false)
    expect(V.validateManifest(manifest(), [...FNS, ...V.EXTENSION_FNS]).has.extensions).toBe(true)
    expect(() => V.validateManifest(manifest(), [...FNS, 'extensions', 'addExtension'])).toThrow(/needs all of/)
  })
  it('the sandbox lets Flick call each of the five functions', () => {
    const allowed = hostJs.match(/if \((\[[^\]]+\])\.indexOf\(fn\)/)![1]
    for (const f of V.EXTENSION_FNS) expect(allowed).toContain(`'${f}'`)
  })
  it('a plugin returning 501 rows from extensions() is rejected; 500 pass', () => {
    expect(() => V.validateExtensions(Array.from({ length: 501 }, (_, i) => row(i)))).toThrow(/at most 500/)
    expect(V.validateExtensions(Array.from({ length: 500 }, (_, i) => row(i)))).toHaveLength(500)
  })
  it('keeps https and stremio:// rows only, bounds strings, drops http logos', () => {
    const out = V.validateExtensions([
      row(1, { logo: 'http://a1.example.org/logo.png', types: ['movie', 'series', 7], description: 'x'.repeat(900) }),
      row(2, { url: 'stremio://a2.example.org/manifest.json', logo: 'https://a2.example.org/l.png' }),
      row(3, { url: 'http://a3.example.org/manifest.json' }),
      row(4, { url: 'javascript:alert(1)' }),
      row(5, { name: '' }),
      'nope',
    ])
    expect(out.map((e) => e.id)).toEqual(['org.example.a1', 'org.example.a2'])
    expect(out[0].logo).toBeUndefined()
    expect(out[0].types).toEqual(['movie', 'series'])
    expect(out[0].description).toHaveLength(500)
    expect(out[0]).not.toHaveProperty('installed')
    expect(out[1].logo).toBe('https://a2.example.org/l.png')
  })
  it('one row with a field of the wrong type is skipped, not the whole list', () => {
    const out = V.validateExtensions([row(1, { types: 'movie' }), row(2, { description: { en: 'x' } }), row(3, { name: ['X'] }), row(4)])
    expect(out.map((e) => e.id)).toEqual(['org.example.a4'])
  })
  it('a service plugin cannot host addons', () => {
    const svc = { api: 1, kind: 'service', provides: ['debrid'], id: 'app.example.debrid', name: 'D', version: '1', hosts: ['api.example.app'] }
    expect(() => V.validateManifest(svc, ['account', 'cached', 'resolve', ...V.EXTENSION_FNS])).toThrow(/cannot host addons/)
  })
  it('catalog rows carry installed as a boolean; removable defaults to false', () => {
    const [a, b] = V.validateExtensions([row(1, { installed: true }), { ...row(2), removable: 'yes' }], true)
    expect([a.installed, b.installed, b.removable]).toEqual([true, false, false])
  })
  it('extensionUrl takes https and stremio only', () => {
    expect(V.extensionUrl(' https://torrentio.strem.fun/manifest.json ')).toBe('https://torrentio.strem.fun/manifest.json')
    expect(V.extensionUrl('stremio://torrentio.strem.fun/manifest.json')).toBe('stremio://torrentio.strem.fun/manifest.json')
    for (const bad of ['http://torrentio.strem.fun/manifest.json', 'javascript:alert(1)', 'file:///etc/passwd', 'https://', '', 7]) {
      expect(() => V.extensionUrl(bad)).toThrow(/https:\/\/ or stremio:\/\//)
    }
  })
  it('a result may change only declared, non-secret settings, each in its own type, and only when ok', () => {
    const fields = V.validateManifest(manifest(), FNS).settings
    const r = V.validateExtensionResult({ ok: true, message: 'Added', settings: { addons: ['https://a', 3], token: 'steal', mode: 'c', other: 1 } }, fields)
    expect(r).toEqual({ ok: true, message: 'Added', settings: { addons: ['https://a'] } })
    expect(V.validateExtensionResult({ ok: true, settings: { mode: 'b' } }, fields).settings).toEqual({ mode: 'b' })
    expect(V.validateExtensionResult({ ok: false, message: 'No', settings: { addons: [] } }, fields)).toEqual({ ok: false, message: 'No' })
    expect(V.validateExtensionResult({ settings: { addons: [] } }, fields).settings).toBeUndefined()
  })
})

describe('adding and removing from Flick', () => {
  const rec = { id: 'org.example.addons', kind: 'source', manifest: V.validateManifest(manifest(), [...FNS, ...V.EXTENSION_FNS]) } as unknown as Installed
  const deps = (reply: unknown) => {
    const calls: unknown[][] = [], saved: unknown[][] = []
    return {
      calls, saved,
      deps: {
        call: (async (_r: Installed, fn: string, args: unknown[]) => { calls.push([fn, ...args]); return reply }) as unknown as E.Deps['call'],
        saveSettings: async (id: string, patch: Record<string, unknown>) => { saved.push([id, patch]) },
      },
    }
  }
  it('addExtension with an http:// or javascript: address is rejected before the plugin sees it; nothing saved', async () => {
    for (const bad of ['http://torrentio.strem.fun/manifest.json', 'javascript:alert(1)']) {
      const d = deps({ ok: true, settings: { addons: [bad] } })
      await expect(E.addExtension(rec, bad, d.deps)).rejects.toThrow(/https:\/\//)
      expect(d.calls).toEqual([])
      expect(d.saved).toEqual([])
    }
  })
  it('a good address goes to the plugin and the settings it returns are saved', async () => {
    const d = deps({ ok: true, settings: { addons: ['https://torrentio.strem.fun/manifest.json'] } })
    await E.addExtension(rec, 'https://torrentio.strem.fun/manifest.json', d.deps)
    expect(d.calls).toEqual([['addExtension', { url: 'https://torrentio.strem.fun/manifest.json' }]])
    expect(d.saved).toEqual([['org.example.addons', { addons: ['https://torrentio.strem.fun/manifest.json'] }]])
  })
  it('remove sends the id; a failed result saves nothing', async () => {
    const d = deps({ ok: false, message: 'Not removable' })
    expect(await E.removeExtension(rec, 'com.linvo.cinemeta', d.deps)).toEqual({ ok: false, message: 'Not removable' })
    expect(d.calls).toEqual([['removeExtension', { id: 'com.linvo.cinemeta' }]])
    expect(d.saved).toEqual([])
  })
  it('inspect refuses a row for another host than the address asked', async () => {
    const d = deps({ id: 'com.linvo.cinemeta', name: 'Cinemeta', url: 'https://v3-cinemeta.strem.io/manifest.json', removable: false, installed: false })
    await expect(E.inspectExtension(rec, 'https://a.example/manifest.json', d.deps)).rejects.toThrow(/not a\.example/)
  })
  it('inspect checks the address too', async () => {
    const d = deps({})
    await expect(E.inspectExtension(rec, 'ftp://x.example/manifest.json', d.deps)).rejects.toThrow()
    expect(d.calls).toEqual([])
  })
})

describe('showing an addon address', () => {
  it('an addon URL with torbox=abc123XYZ9 shows as torbox=•••XYZ9', () => {
    expect(E.maskUrl('https://torrentio.strem.fun/torbox=abc123XYZ9/manifest.json')).toBe('https://torrentio.strem.fun/torbox=•••XYZ9/manifest.json')
    expect(E.maskUrl('stremio://torrentio.strem.fun/sort=size|realdebrid=RDKEY00017/manifest.json')).toBe('stremio://torrentio.strem.fun/sort=size|realdebrid=•••0017/manifest.json')
  })
  it('a key inside an encoded config never shows in full', () => {
    const cfg = btoa(JSON.stringify({ ['debrid' + 'Service']: 'torbox', ['debrid' + 'Api' + 'Key']: 'TBkeyHidden99' }))
    const shown = E.maskUrl(`https://comet.example.app/${cfg}/manifest.json`)
    expect(shown).not.toContain(cfg)
    expect(atob(shown.split('/')[3].replace(/•/g, ''))).not.toContain('TBkeyHidden99')
  })
  it('the host survives, and a config that is the last segment is masked too', () => {
    const cfg = btoa(JSON.stringify({ ['debrid' + 'Service']: 'torbox', ['debrid' + 'Api' + 'Key']: 'TBkeyHidden99' })).replace(/=+$/, '')
    expect(E.maskUrl(`https://comet.elfhosted.com/${cfg}/manifest.json`)).toBe(`https://comet.elfhosted.com/\u2022\u2022\u2022${cfg.slice(-4)}/manifest.json`)
    expect(E.maskUrl(`https://comet.elfhosted.com/${cfg}`)).toBe(`https://comet.elfhosted.com/\u2022\u2022\u2022${cfg.slice(-4)}`)
  })
  it('plugin log lines never show a key from an addon address', () => {
    expect(redact('org.example.none', 'Could not read https://torrentio.strem.fun/torbox=abc123XYZ9/manifest.json: 500')).toBe('Could not read https://torrentio.strem.fun/torbox=\u2022\u2022\u2022XYZ9/manifest.json: 500')
  })
  it('an address with no key is unchanged', () => {
    expect(E.maskUrl('https://v3-cinemeta.strem.io/manifest.json')).toBe('https://v3-cinemeta.strem.io/manifest.json')
    expect(E.hostOf('stremio://torrentio.strem.fun/manifest.json')).toBe('torrentio.strem.fun')
  })
})
