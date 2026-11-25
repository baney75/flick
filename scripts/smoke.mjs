// Headless smoke test: serves the built site, plays a real file, checks the keys,
// subtitles, saved progress and the Stremio pages. Screenshots land in test-media/shots.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = 4178
// SMOKE_BASE=https://flick-player.pages.dev checks a deployed site instead of a local build.
const BASE = process.env.SMOKE_BASE ?? `http://localhost:${PORT}`
const media = 'test-media/Sample.Clip.2023.webm'
if (!existsSync(media)) {
  mkdirSync('test-media', { recursive: true })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-shortest', media])
}
mkdirSync('test-media/shots', { recursive: true })
execFileSync('sh', ['-c', "printf '1\\n00:00:00,000 --> 00:00:30,000\\nHello from Flick\\n' > test-media/sample.srt"])

// A tiny 3 page PDF, so the book reader has something to open.
function writePdf(path, pages = 3) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`]
  for (let i = 0; i < pages; i++) {
    const c = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`)
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`)
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offs = objs.map((o, n) => { const at = out.length; out += `${n + 1} 0 obj\n${o}\nendobj\n`; return at })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  writeFileSync(path, out, 'latin1')
}
const book = 'test-media/Jane Doe - Test Book (2020).pdf'
writePdf(book)

const server = process.env.SMOKE_BASE ? null : spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const fails = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails.push(what) }

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/`); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  const t0 = Date.now()
  await page.goto(`${BASE}/`)
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
  await page.goto(`${BASE}/#/stremio`)
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
  await page.goto(`${BASE}/#/stremio`)
  await page.getByLabel('Search Stremio').fill('interstellar')
  await page.keyboard.press('Enter')
  await page.getByText(/Interstellar/).first().waitFor({ timeout: 15000 })
  check(true, 'Stremio search finds Interstellar')

  // Setup link: review first, apply only on Connect all.
  const setupCode = Buffer.from(JSON.stringify({ v: 1, settings: { skipSeconds: 30 } })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${setupCode}`)
  await page.getByText('Settings: skip 30 seconds').waitFor()
  check(await page.evaluate(() => !localStorage.getItem('flick.settings')?.includes('"skipSeconds":30')), 'setup link changes nothing before the tap')
  await page.getByRole('button', { name: 'Connect all' }).click()
  await page.getByText('Done').waitFor()
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('flick.settings')).skipSeconds === 30), 'Connect all applies the setup')
  await page.screenshot({ path: 'test-media/shots/setup.png' })

  // Books: store a PDF, read it, and reopen it in a fresh tab where the library loads after the reader mounts.
  await page.goto(`${BASE}/#/library`)
  const bookChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /Store files/ }).click()
  await (await bookChooser).setFiles(book)
  await page.getByRole('tab', { name: /Books/ }).click()
  await page.getByText('Test Book').first().click()
  await page.locator('.reader-stage canvas').waitFor({ timeout: 15000 })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.reader-page input')?.value === '2')
  const readUrl = page.url()
  const fresh = await page.context().newPage()
  fresh.on('pageerror', (e) => errors.push(e.message))
  await fresh.goto(readUrl)
  const drawn = await fresh.waitForFunction(() => {
    const c = document.querySelector('.reader-stage canvas')
    return c && c.style.width && document.querySelector('.reader-page input')?.value === '2'
  }, null, { timeout: 15000 }).then(() => true, () => false)
  check(drawn, 'book reopens on its saved page in a fresh tab')
  await fresh.screenshot({ path: 'test-media/shots/reader.png' })
  await fresh.close()

  // Phone layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/#/library`)
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  check(!overflow, 'no sideways scroll at 390px')
  await page.screenshot({ path: 'test-media/shots/phone-library.png' })
  await page.goto(`${BASE}/#/stremio`)
  await page.locator('.row-section .card:not(.skeleton)').first().waitFor({ timeout: 15000 })
  await page.screenshot({ path: 'test-media/shots/phone-stremio.png' })

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await browser.close()
} finally {
  server?.kill()
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1) }
console.log('\nsmoke: all checks passed')
