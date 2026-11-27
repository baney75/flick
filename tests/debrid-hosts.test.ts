// SPEC-debrid rule 6 with the debridHosts the bundled services really declare: `*.host` entries (audit P15 F4).
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { streamCandidates } from '../src/lib/candidates'
import { rank, VPN_DEBRID } from '../src/lib/pick'
vi.hoisted(() => { Object.assign(globalThis, { location: { hash: '', href: 'http://localhost/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} }) })
vi.mock('../src/lib/platform', async (orig) => ({ ...(await orig<typeof import('../src/lib/platform')>()), isDesktop: true, isMobileApp: false, invoke: async () => ({ ok: false }) }))
const { debridNow } = await import('../src/lib/picking')
const { installed } = await import('../src/lib/plugins/registry')
const V = await import('../src/lib/plugins/validate')

const bundled = ['torbox', 'realdebrid', 'alldebrid', 'premiumize']
const manifests = await Promise.all(bundled.map(async (name) => {
  const p = (await import(`../plugins/${name}/plugin.js`)).default as Record<string, unknown>
  const data = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== 'function'))
  return V.validateManifest(JSON.parse(JSON.stringify(data)), Object.keys(p).filter((k) => typeof p[k] === 'function'))
}))
const dev = { maxQuality: '1080p', hdr: false, codecs: {}, desktop: true, phone: false } as never
const prefs = { audio: ['en'], subs: [], maxQuality: '4K' } as never

describe('a link on a bundled service\'s download host', () => {
  for (const m of manifests) {
    for (const h of m.debridHosts) {
      const url = `https://${h.replace(/^\*\./, 'store-031.weur.')}/dl/x.mkv`
      it(`${m.name}: ${url} is that service's stream (rule 6)`, () => {
        installed.value = manifests.map((x) => ({ id: x.id, kind: 'service', manifest: x }) as never)
        const c = streamCandidates('k', [{ url }], { debrid: debridNow() })
        expect(c[0]).toMatchObject({ via: 'debrid-cached', service: m.id })
      })
      it(`${m.name}: ${url} waits for the VPN when "Require a VPN for debrid services too" is on`, () => {
        installed.value = manifests.map((x) => ({ id: x.id, kind: 'service', manifest: x }) as never)
        const c = streamCandidates('k', [{ url }], { debrid: debridNow() })
        expect(rank(c, prefs, dev, { gate: false, vpnForDebrid: true, online: true })[0].blocked).toBe(VPN_DEBRID)
        expect(rank(c, prefs, dev, { gate: false, vpnForDebrid: false, online: true })[0].blocked).toBeUndefined()
      })
    }
  }
  it('every bundled service declares a wildcard download host', () => {
    expect(manifests.every((m) => m.debridHosts.some((h) => h.startsWith('*.')))).toBe(true)
  })
  it('a look-alike host is not a download host', () => {
    installed.value = manifests.map((x) => ({ id: x.id, kind: 'service', manifest: x }) as never)
    const c = streamCandidates('k', [{ url: 'https://evil-tb-cdn.st/x.mkv' }, { url: 'https://tb-cdn.st.evil.example/x.mkv' }], { debrid: debridNow() })
    expect(c.map((x) => x.via)).toEqual(['direct', 'direct'])
  })
})
