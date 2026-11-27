import { describe, it, expect } from 'vitest'
import index from '../plugins/index.json'
import { anchorOf, reachLine } from '../src/lib/hub'

const mods = import.meta.glob('../plugins/*/plugin.js', { eager: true }) as Record<string, { default: { hosts: string[] } }>

describe("Flick's plugin list", () => {
  it('lists each bundled plugin with the hosts its manifest asks for', () => {
    for (const e of index.plugins) {
      const dir = e.url.match(/^\/plugins\/(.+)\.js$/)![1]
      expect(e.hosts, e.name).toEqual(mods[`../plugins/${dir}/plugin.js`].default.hosts)
    }
  })
})

describe('reachLine', () => {
  it.each([
    [['*'], 'Reaches any public website'],
    [['archive.org', '*.archive.org', '*.us.archive.org'], 'Reaches archive.org'],
    [['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'], 'Reaches youtube.com, youtu.be'],
    [['api.torbox.app', '*.tb-cdn.st', '*.tb-cdn.io', '*.tb-cdn.cx'], 'Reaches torbox.app, tb-cdn.st and 2 more'],
    [[], 'Reaches nothing online'],
  ])('%j -> %s', (hosts, line) => expect(reachLine(hosts)).toBe(line))
})

describe('anchorOf', () => {
  it.each([
    ['/servers', 'servers'],
    ['/settings/servers', 'servers'],
    ['/services', 'services'],
    ['/settings/services', 'services'],
    ['/settings/plugins', 'plugins'],
    ['/settings', null],
  ])('%s -> %s', (r, a) => expect(anchorOf(r)).toBe(a))
})
