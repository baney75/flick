// The apps' plugin page must leave ctx.fetch as the plugin's only network (review of #32, round 2).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const csp = (file: string) => {
  const html = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8')
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)
  if (!m) throw new Error(`${file} has no CSP`)
  return Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]))
}

describe('plugin host pages', () => {
  it('the app page allows no network of its own', () => {
    const p = csp('plugin-host-app.html')
    expect(p['default-src']).toEqual(["'none'"])
    expect(p['connect-src']).toEqual(["'none'"])
    for (const d of ['img-src', 'media-src', 'font-src', 'frame-src', 'worker-src']) {
      for (const src of p[d] ?? ["'none'"]) expect(['data:', 'blob:', "'none'"]).toContain(src)
    }
    expect(p['script-src']).not.toContain('*')
    expect(p['script-src'].some((s: string) => /^https?:/.test(s))).toBe(false)
  })
  it('the apps load the app page', () => {
    const src = readFileSync(new URL('../src/lib/plugins/runtime.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/HOST_PAGE = isDesktop \? '\/plugin-host-app\.html' : '\/plugin-host\.html'/)
  })
})
