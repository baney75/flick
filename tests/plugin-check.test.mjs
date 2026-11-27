// npm run plugin:check on a plugin whose user rows depend on a sign-in (#157).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (file) => spawnSync(process.execPath, ['scripts/plugin-check.mjs', file], { encoding: 'utf8', timeout: 30_000 })
const FIXTURE = 'tests/fixtures/user-rows-plugin.js'

describe('plugin:check and userCatalogs()', () => {
  it('passes zero user rows with a note to sign in', () => {
    const r = run(FIXTURE)
    expect(r.stdout).toContain('PASS userCatalogs(): 0 rows')
    expect(r.stdout).toContain('note: no user rows; sign in or fill a list to check them')
    expect(r.status).toBe(0)
  })
  it('still fails user rows of the wrong shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flick-plugin-check-'))
    const bad = join(dir, 'bad.js')
    writeFileSync(bad, readFileSync(FIXTURE, 'utf8').replace(/async userCatalogs\(ctx\) \{.*\},/, 'async userCatalogs() { return [{ id: 5 }] },'))
    const r = run(bad)
    expect(r.stdout).toMatch(/FAIL userCatalogs\(\)/)
    expect(r.status).toBe(1)
  })
})
