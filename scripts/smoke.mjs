// Headless smoke test: serves the built site, plays a real file, checks the keys,
// subtitles, saved progress and the Stremio pages. Screenshots land in test-media/shots.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

const PORT = 4178
const media = 'test-media/Sample.Clip.2023.webm'
if (!existsSync(media)) {
  mkdirSync('test-media', { recursive: true })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-shortest', media])
}
mkdirSync('test-media/shots', { recursive: true })
execFileSync('sh', ['-c', "printf '1\\n00:00:00,000 --> 00:00:30,000\\nHello from Flick\\n' > test-media/sample.srt"])

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const fails = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails.push(what) }

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/`); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  const t0 = Date.now()
  await page.goto(`http://localhost:${PORT}/`)
  await page.getByText('Drop anything here to play it.').waitFor()
  check(Date.now() - t0 < 3000, `first screen in ${Date.now() - t0} ms`)
  await page.screenshot({ path: 'test-media/shots/home-empty.png' })

  // Open a file through the button, as a user would.
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open a file' }).click()
  await (await chooser).setFiles(media)
  await page.locator('.player').waitFor()
  await page.waitForFunction(() => (document.querySelector('.player video')?.currentTime ?? 0) > 1, null, { timeout: 8000 })
  check(true, 'video plays after opening a file')
  check(await page.locator('.top-bar .t1').innerText() === 'Sample Clip', 'title parsed from the file name')

  const before = await page.evaluate(() => document.querySelector('.player video').currentTime)
  await page.keyboard.press('l')
  const after = await page.evaluate(() => document.querySelector('.player video').currentTime)
  check(after - before > 9, `L skips ahead 10s (${before.toFixed(1)} -> ${after.toFixed(1)})`)
  await page.keyboard.press(' ')
  check(await page.evaluate(() => document.querySelector('.player video').paused), 'Space pauses')
  await page.keyboard.press(']')
  check(await page.evaluate(() => document.querySelector('.player video').playbackRate) === 1.1, '] speeds up')

  // Subtitles from a file.
  await page.getByRole('button', { name: 'Subtitles (C)' }).click()
  const subChooser = page.waitForEvent('filechooser')
  await page.getByText('Load subtitle file…').click()
  await (await subChooser).setFiles('test-media/sample.srt')
  await page.waitForFunction(() => { const t = document.querySelector('.player video').textTracks; return t.length === 1 && t[0].mode === 'showing' })
  check(true, 'SRT subtitles load and show')
  await page.mouse.move(640, 400)
  await page.screenshot({ path: 'test-media/shots/player.png' })

  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  const saved = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('flick')
    r.onsuccess = () => { const q = r.result.transaction('progress').objectStore('progress').getAll(); q.onsuccess = () => res(q.result) }
  }))
  check(saved.length === 1 && saved[0].pos > 10, `progress saved (${saved[0]?.pos?.toFixed(1)}s)`)

  // Stremio without an account: Cinemeta catalogs and a title page.
  await page.goto(`http://localhost:${PORT}/#/stremio`)
  const firstCard = page.locator('.row-section .card:not(.skeleton)').first()
  await firstCard.waitFor({ timeout: 15000 })
  check(await page.locator('.row-section').count() > 1, `Cinemeta catalogs load (${await page.locator('.row-section').count()} rows)`)
  await page.screenshot({ path: 'test-media/shots/stremio.png' })
  await firstCard.click()
  await page.locator('.detail-info').waitFor({ timeout: 15000 })
  await page.locator('.streams').waitFor()
  check(true, 'title page opens with details and a streams section')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'test-media/shots/detail.png' })

  // Search.
  await page.goto(`http://localhost:${PORT}/#/stremio`)
  await page.getByLabel('Search Stremio').fill('interstellar')
  await page.keyboard.press('Enter')
  await page.getByText(/Interstellar/).first().waitFor({ timeout: 15000 })
  check(true, 'Stremio search finds Interstellar')

  // Phone layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${PORT}/#/library`)
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  check(!overflow, 'no sideways scroll at 390px')
  await page.screenshot({ path: 'test-media/shots/phone-library.png' })
  await page.goto(`http://localhost:${PORT}/#/stremio`)
  await page.locator('.row-section .card:not(.skeleton)').first().waitFor({ timeout: 15000 })
  await page.screenshot({ path: 'test-media/shots/phone-stremio.png' })

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await browser.close()
} finally {
  server.kill()
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1) }
console.log('\nsmoke: all checks passed')
