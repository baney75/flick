// The apps' plugin page must leave ctx.fetch as the plugin's only network (review of #32, round 2).
import { describe, expect, it } from 'vitest'
import appHost from '../public/plugin-host-app.html?raw'
import runtime from '../src/lib/plugins/runtime.ts?raw'

const csp = (html: string): Record<string, string[]> => {
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)
  if (!m) throw new Error('no CSP')
  return Object.fromEntries(m[1].split(';').map((d: string) => d.trim().split(/\s+/)).filter((d: string[]) => d[0]).map(([k, ...v]: string[]) => [k, v]))
}

describe('plugin host pages', () => {
  it('the app page allows no network of its own', () => {
    const p = csp(appHost)
    expect(p['default-src']).toEqual(["'none'"])
    expect(p['connect-src']).toEqual(["'none'"])
    for (const d of ['img-src', 'media-src', 'font-src', 'frame-src', 'worker-src']) {
      for (const src of p[d] ?? ["'none'"]) expect(['data:', 'blob:', "'none'"]).toContain(src)
    }
    expect(p['script-src']).not.toContain('*')
    expect(p['script-src'].some((s: string) => /^https?:/.test(s))).toBe(false)
  })
  it('the app page can run its own script from the app scheme', () => {
    // In the sandboxed (opaque origin) frame, WebKit matches 'self' to nothing on tauri://, so the host
    // script never ran and every install waited 20 s for a sandbox that never answered.
    expect(csp(appHost)['script-src']).toEqual(["'self'", 'tauri://localhost', 'blob:', 'data:'])
  })
  it('the apps load the app page', () => {
    expect(runtime).toMatch(/HOST_PAGE = isDesktop \? '\/plugin-host-app\.html' : '\/plugin-host\.html'/)
  })
})
