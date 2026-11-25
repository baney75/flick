// Sync check: two separate browser profiles pair through a local relay (wrangler dev),
// see each other online, and find each other again after a reload.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4179, RELAY_PORT = 8797
const BASE = `http://localhost:${PORT}`
const procs = [
  spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true }),
  spawn('npx', ['wrangler', 'dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1'], { cwd: 'relay', stdio: ['ignore', 'pipe', 'pipe'], detached: true }),
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
    await ctx.addInitScript((r) => localStorage.setItem('flick.relay', r), `ws://127.0.0.1:${RELAY_PORT}`)
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

  // A device that drops off comes back on its own.
  await b.reload()
  await b.goto(b.url().replace(/#.*$/, '#/settings'))
  check(await until(() => b.getByText('Online now').isVisible()), 'a reloaded device reconnects and sees the other again')
  await browser.close()
} catch (e) {
  fails.push(String(e))
} finally {
  for (const p of procs) try { process.kill(-p.pid) } catch { /* gone */ }
}
for (const f of fails) console.log(`FAIL ${f}`)
console.log(fails.length ? `sync: ${fails.length} failed` : 'sync: all checks passed')
process.exit(fails.length ? 1 : 0)
