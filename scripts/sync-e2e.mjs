// Sync check: two separate browser profiles pair through a local relay (wrangler dev),
// then a setting changed on one shows up on the other, and the device list sees both.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { freePort } from './free-port.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = await freePort(), RELAY_PORT = await freePort(), INSPECTOR = await freePort()
const BASE = `http://localhost:${PORT}`
const procs = [
  spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true }),
  spawn('npx', ['wrangler', 'dev', '--port', String(RELAY_PORT), '--inspector-port', String(INSPECTOR), '--persist-to', mkdtempSync(join(tmpdir(), 'flick-relay-')), '--ip', '127.0.0.1'], { cwd: 'relay', stdio: ['ignore', 'pipe', 'pipe'], detached: true }),
]
const fails = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails.push(what) }
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)) } return false }

try {
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('relay did not start')), 60000)
    const on = (b) => { if (/Ready on/.test(String(b))) { clearTimeout(t); ok() } }
    procs[1].stdout.on('data', on); procs[1].stderr.on('data', on)
  })
  await until(async () => { try { return (await fetch(BASE)).ok } catch { return false } })
  const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'chrome' })
  const open = async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    // Init scripts run in every frame; the plugin sandbox has no storage, as intended.
    await ctx.addInitScript((r) => { if (window === top) localStorage.setItem('flick.relay', r) }, `ws://127.0.0.1:${RELAY_PORT}`)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => fails.push(`page error: ${e.message}`))
    await page.goto(`${BASE}/#/settings`)
    return page
  }
  const a = await open(), b = await open()

  await a.getByRole('button', { name: 'Start sync on this device' }).click()
  check(await until(() => a.locator('.qr svg').isVisible()), 'a pairing QR code shows')
  await a.getByRole('button', { name: 'Copy link' }).click()
  const link = await a.evaluate(() => navigator.clipboard.readText())
  check(/#\/pair\?k=[A-Za-z0-9_-]{43}$/.test(link), 'the pairing link carries the code in the #fragment')

  await b.goto(link.replace('https://flick-player.pages.dev/', `${BASE}/`))
  check(!(await b.evaluate(() => location.hash)).includes('k='), 'the code is wiped from the address bar once read')
  await b.getByRole('button', { name: 'Join' }).click()
  await b.waitForURL(/#\/settings/)
  check(await until(() => b.getByText('Online now').isVisible()), 'the second device sees the first online')
  check(await until(() => a.getByText('Online now').isVisible()), 'the first device sees the second online')

  await a.getByLabel('Skip buttons jump').selectOption('30')
  check(await until(async () => (await b.getByLabel('Skip buttons jump').inputValue()) === '30'), 'a setting changed on one device appears on the other')
  await b.getByLabel('Default speed').selectOption('1.5')
  check(await until(async () => (await a.getByLabel('Default speed').inputValue()) === '1.5'), 'and the other way')

  // A plugin installed on one device shows up on the other, with its review done on the first.
  await a.locator('.list-row', { hasText: 'Internet Archive' }).getByRole('button', { name: 'Install' }).click()
  await a.getByRole('dialog').getByRole('button', { name: 'Install' }).click()
  check(await until(() => b.getByRole('link', { name: 'Open Internet Archive' }).isVisible()), 'a plugin installed on one device appears on the other')

  // A device that was offline catches up when it reconnects.
  await b.reload()
  await b.goto(b.url().replace(/#.*$/, '#/settings'))
  check(await until(() => b.getByText('Online now').isVisible()), 'a reloaded device reconnects and sees the other again')
  await a.getByLabel('Skip buttons jump').selectOption('15')
  const caught = await until(async () => (await b.getByLabel('Skip buttons jump').inputValue()) === '15')
  check(caught, 'a reloaded device catches up')
  await until(() => a.getByText('Online now').isVisible())
  await b.close({ runBeforeUnload: true })
  check(await until(async () => !(await a.getByText('Online now').isVisible())), 'a device that closes its page shows offline on the other')

  // Leaving in one tab reaches this browser's other tabs, so a stale tab cannot put the device back.
  const a2 = await a.context().newPage()
  await a2.goto(`${BASE}/#/settings`)
  await until(() => a2.getByText('Connected').isVisible())
  // Two tabs share one stored doc. A change made in one tab must survive the other tab saving later.
  const savedDoc = (page) => page.evaluate(() => new Promise((ok) => {
    const r = indexedDB.open('flick')
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('sync.doc'); g.onsuccess = () => ok(Object.fromEntries((g.result?.rows ?? []).map(([k, e]) => [k, e.v]))) }
  }))
  await a2.getByLabel('Default speed').selectOption('2')
  await until(async () => (await savedDoc(a2))['s:speed'] === 2)
  await a.getByLabel('Skip buttons jump').selectOption('5')
  check(await until(async () => { const d = await savedDoc(a); return d['s:skipSeconds'] === 5 && d['s:speed'] === 2 }), 'a change in one tab survives another tab saving after it')
  check(!(await a.getByText('Online now').isVisible()), 'another tab of the same browser is not listed as a device')
  a.once('dialog', (d) => d.accept())
  await a.getByRole('button', { name: 'Leave sync' }).click()
  check(await until(() => a2.getByRole('button', { name: /Start sync on this device/ }).isVisible()), 'leaving sync in one tab leaves it in the other tabs too')
  await a2.reload()
  check(await until(() => a2.getByRole('button', { name: /Start sync on this device/ }).isVisible()), 'and it stays left after a reload')
  await browser.close()
} catch (e) {
  fails.push(String(e))
} finally {
  for (const p of procs) try { process.kill(-p.pid) } catch { /* gone */ }
}
for (const f of fails) console.log(`FAIL ${f}`)
console.log(fails.length ? `sync: ${fails.length} failed` : 'sync: all checks passed')
process.exit(fails.length ? 1 : 0)
