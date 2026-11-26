// Headless smoke test: serves the built site, plays a real file, checks the keys,
// subtitles, saved progress, plugins (the Stremio plugin among them) and themes. Screenshots land in test-media/shots.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { make as makeAudio } from '../tests/media-setup.mjs'
import { makeEpub, EVIL } from './epub-fixture.mjs'

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

// A tiny 3 page PDF, so the book reader has something to open. Page 1 also has Japanese text in a
// font the file does not embed, which pdf.js can draw only with the character maps the build ships.
function writePdf(path, pages = 3) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`]
  for (let i = 0; i < pages; i++) {
    const c = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET` + (i === 0 ? ' BT /F2 36 Tf 72 600 Td <65E5672C> Tj ET' : '')
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R /F2 ${4 + pages * 2} 0 R >> >> >>`)
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`)
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  objs.push(`<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [${5 + pages * 2} 0 R] >>`)
  objs.push(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ${6 + pages * 2} 0 R >>`)
  objs.push('<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>')
  let out = '%PDF-1.4\n'
  const offs = objs.map((o, n) => { const at = out.length; out += `${n + 1} 0 obj\n${o}\nendobj\n`; return at })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  writeFileSync(path, out, 'latin1')
}
const book = 'test-media/Jane Doe - Test Book (2020).pdf'
writePdf(book)
// An M4B with three chapters and a cover, and two MP3 parts for a book in a folder (tests/media-setup.mjs).
if (!existsSync('test-media/audiobook/book.m4b')) makeAudio()
const m4b = 'test-media/Jane Doe - Test Audiobook.m4b'
writeFileSync(m4b, readFileSync('test-media/audiobook/book.m4b'))
// EPUBs: one with a cover, nav contents and every trick a hostile book might try; one EPUB 2 with NCX contents.
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x8a2be2:s=120x180', '-frames:v', '1', 'test-media/cover.png'])
const epub = 'test-media/Jane Doe - Test Epub (2020).epub'
writeFileSync(epub, makeEpub({ title: 'Test Epub', author: 'Jane Doe', cover: readFileSync('test-media/cover.png'), chapters: [['Chapter One', EVIL], ['Chapter Two'], ['Chapter Three']] }))
const serverEpub = makeEpub({ title: 'Server Epub', author: 'John Roe', ncx: true, chapters: [['First Part'], ['Second Part']] })

// A mock flick-server (see the flick-server API): info, library, media with Range, CORS and an access code.
const FLICK_CODE = 'smoke_code_0123456789abcdefghijklmnopqrstuvwx'
const flickFiles = {
  a1: { folder: 'Movies', name: 'Server.Movie.2024.webm', kind: 'video', ext: 'webm', type: 'video/webm', body: readFileSync(media) },
  b2: { folder: 'Books', name: 'John Roe - Server Book (2021).pdf', kind: 'book', ext: 'pdf', type: 'application/pdf', body: readFileSync(book) },
  d4: { folder: 'Audiobooks', path: 'John Roe/Part Book/01 Part.mp3', name: '01 Part.mp3', kind: 'audio', ext: 'mp3', type: 'audio/mpeg', body: readFileSync('test-media/audiobook/01 Part.mp3') },
  e5: { folder: 'Audiobooks', path: 'John Roe/Part Book/02 Part.mp3', name: '02 Part.mp3', kind: 'audio', ext: 'mp3', type: 'audio/mpeg', body: readFileSync('test-media/audiobook/02 Part.mp3') },
  f6: { folder: 'Audiobooks', name: 'John Roe - Server Audiobook.m4b', kind: 'audio', ext: 'm4b', type: 'audio/mp4', body: readFileSync('test-media/audiobook/book.m4b') },
  c3: { folder: 'Books', name: 'John Roe - Server Epub (2022).epub', kind: 'book', ext: 'epub', type: 'application/epub+zip', body: serverEpub },
}
const SMOKE_PLUGIN = `
const r = {}
const t = async (k, f) => { try { await f(); r[k] = 1 } catch { /* blocked */ } }
export default {
  api: 1, id: 'org.smoke.films', name: 'Smoke Films', version: '1.0.0', author: 'Smoke',
  hosts: ['127.0.0.1'],
  catalogs: [{ id: 'all', name: 'Smoke catalog', type: 'movie' }, { id: 'sandbox', name: 'Sandbox report', type: 'movie' }, { id: 'find', name: 'Find', type: 'movie', search: true }],
  async catalog(ctx, { id, search }) {
    if (id === 'sandbox') {
      await t('indexedDB', () => new Promise((ok, no) => { const q = indexedDB.open('flick'); q.onsuccess = ok; q.onerror = () => no(q.error) }))
      await t('localStorage', () => localStorage.length)
      await t('parent', () => parent.document.title)
      const open = Object.keys(r)
      return { items: [{ id: 'probe', type: 'movie', name: open.length ? 'sandbox open: ' + open.join(' ') : 'sandbox: sealed' }] }
    }
    const info = await (await ctx.fetch('$BASE/api/info')).json()
    if (search && !'smoke clip'.includes(search.toLowerCase())) return { items: [] }
    return { items: [{ id: 'clip', type: 'movie', name: 'Smoke Clip', year: '2024', description: 'From ' + info.name }] }
  },
  async meta(ctx, { id }) { return { id, type: 'movie', name: 'Smoke Clip', year: '2024', description: 'A test clip.' } },
  async streams(ctx, { id }) {
    await ctx.store.set('last', id)
    return [
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream SD 480p', quality: '480p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream 1080p HDR 1.2 GB', quality: '1080p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream 720p', quality: '720p' },
      { url: '$BASE/media/a1/index.m3u8?t=${FLICK_CODE}', title: 'Smoke stream HLS 480p', quality: '480p' },
    ]
  },
}`
const SMOKE_THEME = {
  flick: 'theme', api: 1, id: 'org.smoke.theme', name: 'Smoke Green', version: '1.0.0', author: 'Smoke',
  light: { bg: '#f4f1ea', surface: '#ffffff', fg: '#1d2420', dim: '#5c675f', line: '#dcd6c8', accent: '#2f7a4f' },
  dark: { bg: '#101512', surface: '#18201b', fg: '#eef2ec', dim: '#9aa79d', line: '#26302a', accent: '#2f7a4f' },
}
const flick = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const u = new URL(req.url, 'http://x')
  const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o))
  if (u.pathname === '/api/info') return json(200, { app: 'flick-server', v: 1, name: 'Smoke NAS', version: '0.0.0' })
  // A test source plugin and theme, installed through Settings > Plugins.
  if (u.pathname === '/plugin.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(SMOKE_PLUGIN.replaceAll('$BASE', `http://127.0.0.1:${flick.address().port}`))
  if (u.pathname === '/theme.json') return json(200, SMOKE_THEME)
  if (req.headers.authorization !== `Bearer ${FLICK_CODE}` && u.searchParams.get('t') !== FLICK_CODE) return json(401, { error: 'wrong code' })
  if (u.pathname === '/api/library') {
    return json(200, { name: 'Smoke NAS', folders: ['Movies', 'Books'], items: Object.entries(flickFiles).map(([id, f]) => ({ id, folder: f.folder, path: f.path ?? f.name, name: f.name, kind: f.kind, ext: f.ext, size: f.body.length, mtime: 1732550400000 })) })
  }
  const f = flickFiles[u.pathname.slice('/media/'.length)]
  if (!u.pathname.startsWith('/media/') || !f) return json(404, { error: 'not found' })
  const total = f.body.length
  const m = /^bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  let [a, b] = [0, total - 1]
  if (m) {
    if (m[1]) { a = +m[1]; if (m[2]) b = Math.min(+m[2], total - 1) } else a = Math.max(0, total - +m[2])
    if (a >= total || a > b) return res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
  }
  res.writeHead(m ? 206 : 200, { 'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${total}` } : {}) })
  res.end(req.method === 'HEAD' ? undefined : f.body.subarray(a, b + 1))
})
await new Promise((r) => flick.listen(0, '127.0.0.1', r))
const FLICK_URL = `http://127.0.0.1:${flick.address().port}`

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
  await page.waitForFunction(() => document.querySelector('.player .subs .cue')?.textContent === 'Hello from Flick', null, { timeout: 5000 }).catch(() => {})
  check(await page.locator('.player .subs .cue').count() === 1, 'SRT subtitles load and show')
  await page.mouse.move(640, 400)
  await page.waitForTimeout(300)
  const clear = await page.evaluate(() => {
    const cue = document.querySelector('.player .subs .cue')?.getBoundingClientRect()
    const bar = document.querySelector('.player .bottom-bar .scrub')?.getBoundingClientRect()
    return cue && bar ? Math.round(bar.top - cue.bottom) : null
  })
  check(clear !== null && clear >= 0, `subtitles sit above the controls (${clear}px clear)`)
  await page.screenshot({ path: 'test-media/shots/player.png' })

  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  const saved = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('flick')
    r.onsuccess = () => { const q = r.result.transaction('progress').objectStore('progress').getAll(); q.onsuccess = () => res(q.result) }
  }))
  check(saved.length === 1 && saved[0].pos > 10, `progress saved (${saved[0]?.pos?.toFixed(1)}s)`)

  // Setup link: review first, apply only on Connect all.
  const setupCode = Buffer.from(JSON.stringify({ v: 1, settings: { skipSeconds: 30 } })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${setupCode}`)
  await page.getByText('Settings: skip 30 seconds').waitFor()
  check(await page.evaluate(() => !localStorage.getItem('flick.settings')?.includes('"skipSeconds":30')), 'setup link changes nothing before the tap')
  await page.getByRole('button', { name: 'Connect all' }).click()
  await page.getByText('Done').waitFor()
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('flick.settings')).skipSeconds === 30), 'Connect all applies the setup')
  await page.screenshot({ path: 'test-media/shots/setup.png' })

  // An older setup link with Stremio addons offers the Stremio plugin in the review, and installs nothing before the tap.
  const oldCode = Buffer.from(JSON.stringify({ v: 1, stremioAddons: ['stremio://v3-cinemeta.strem.io/manifest.json'] })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${oldCode}`)
  check(await page.getByText(/Plugin: Stremio .*reaches any public website, 127\.0\.0\.1$/).waitFor({ timeout: 15000 }).then(() => true, () => false)
    && await page.getByText('Stremio addon in the Stremio plugin: https://v3-cinemeta.strem.io/manifest.json').isVisible(), 'old setup link with Stremio addons offers the Stremio plugin')
  check(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('plugins').objectStore('plugins').count(); q.onsuccess = () => res(q.result === 0) } })), 'and installs nothing before the tap')

  // Sharing this library is a desktop feature: the website has no server to run.
  await page.goto(`${BASE}/#/settings`)
  await page.getByRole('heading', { name: 'Sync across devices' }).waitFor()
  check(await page.getByText('Share this library').count() === 0, 'no Share this library section on the website')

  // Books: store a PDF, read it, and reopen it in a fresh tab where the library loads after the reader mounts.
  await page.goto(`${BASE}/#/library`)
  const bookChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /Store files/ }).click()
  await (await bookChooser).setFiles(book)
  await page.getByRole('tab', { name: /Books/ }).click()
  const cmap = page.waitForResponse((r) => r.url().includes('/cmaps/UniJIS-UCS2-H.bcmap'), { timeout: 15000 }).catch(() => null)
  await page.getByText('Test Book').first().click()
  await page.locator('.reader-stage canvas').waitFor({ timeout: 15000 })
  check((await cmap)?.status() === 200, 'book reader loads the character maps it needs')
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

  // Audiobooks: store an M4B, see its chapters, cover and sleep timer; speed stays with the book.
  await page.goto(`${BASE}/#/library`)
  const abChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /Store files/ }).click()
  await (await abChooser).setFiles(m4b)
  await page.getByRole('tab', { name: /Audiobooks/ }).click()
  await page.getByText('Test Audiobook').first().click()
  const chaptersBtn = page.getByRole('button', { name: /^Chapters/ })
  check(await chaptersBtn.filter({ hasText: 'Chapters (3)' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'M4B chapters are read in the browser')
  check(await page.locator('img.listen-cover').waitFor({ timeout: 3000 }).then(() => true, () => false), 'audiobook cover art shows')
  await chaptersBtn.click()
  const chapterNames = await page.locator('.listen-pop button').allInnerTexts()
  check(chapterNames.length === 3 && chapterNames[1].startsWith('The Middle'), `chapter list (${chapterNames.map((c) => c.split('\n')[0]).join(', ')})`)
  await page.locator('.listen-pop button', { hasText: 'The Middle' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Sleep' }).click()
  const sleepItems = await page.locator('.listen-pop button').allInnerTexts()
  check(['15 minutes', '30 minutes', '45 minutes', '60 minutes', 'End of chapter'].every((s) => sleepItems.includes(s)), `sleep timer menu (${sleepItems.join(', ')})`)
  const popFits = await page.evaluate(() => { const r = document.querySelector('.listen-pop').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })
  check(popFits, 'sleep menu opens fully inside the window')
  await page.screenshot({ path: 'test-media/shots/audiobook.png' })
  await page.locator('.listen-pop button', { hasText: 'End of chapter' }).click()
  // Play fast so timeupdates land past the chapter's end, the way a slow phone does.
  await page.evaluate(() => { document.querySelector('.listen audio').playbackRate = 4 })
  const stopped = await page.waitForFunction(() => { const a = document.querySelector('.listen audio'); return a && a.paused && a.currentTime > 8 }, null, { timeout: 9000 }).then(() => true, () => false)
  await page.waitForTimeout(300)
  const stopAt = await page.evaluate(() => document.querySelector('.listen audio')?.currentTime)
  check(stopped && stopAt > 8 && stopAt < 8.5, `sleep timer stops inside the chapter it ends (${stopAt?.toFixed(2)}s, chapter ends at 8.5s)`)
  await page.getByRole('button', { name: 'Speed' }).click()
  await page.locator('.listen-pop button', { hasText: /^1\.5×$/ }).click()
  await page.goto(`${BASE}/#/library`)
  await page.getByText('Test Audiobook').first().click()
  check(await page.getByRole('button', { name: 'Speed' }).filter({ hasText: '1.5×' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'audiobook speed is remembered for the book')
  check(await page.locator('.listen-book', { hasText: /left at 1\.5×/ }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'time left counts the book speed')
  check(await page.locator('.listen-chapter', { hasText: 'The Middle' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'audiobook resumes in the chapter it stopped in')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'audiobook player fits a phone without sideways scroll')
  await page.screenshot({ path: 'test-media/shots/phone-audiobook.png' })
  await page.setViewportSize({ width: 1280, height: 800 })
  // EPUB: store one, see its cover, page through it, use the contents, and prove the book's scripts never run.
  await page.goto(`${BASE}/#/library`)
  await page.evaluate(() => { window.__pwned = []; addEventListener('message', (e) => { if (e.data?.pwned) window.__pwned.push(e.data.pwned) }) })
  const epubChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /Store files/ }).click()
  await (await epubChooser).setFiles(epub)
  await page.getByRole('tab', { name: /Books/ }).click()
  const epubCard = page.locator('.card', { hasText: 'Test Epub' })
  check(await epubCard.locator('img').waitFor({ timeout: 8000 }).then(() => true, () => false), 'EPUB cover shows as its poster')
  await epubCard.click()
  const pageNo = page.locator('.reader-page')
  const paged = await pageNo.filter({ hasText: /^Page 1 of ([2-9]|\d\d+)/ }).waitFor({ timeout: 10000 }).then(() => true, () => false)
  check(paged, `EPUB opens paged (${await pageNo.innerText().catch(() => 'no page number')})`)
  if (!paged) throw new Error('the EPUB reader did not open')
  await page.keyboard.press('ArrowRight')
  check(await pageNo.filter({ hasText: /^Page 2 of/ }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'arrow key turns the EPUB page')
  const frame = page.frameLocator('.epub-frame')
  await frame.locator('body').click({ position: { x: 20, y: 300 } })
  check(await pageNo.filter({ hasText: /^Page 1 of/ }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'tapping the left side turns back')
  await frame.locator('#evil').click()
  await page.waitForTimeout(500)
  const sandbox = await page.locator('.epub-frame').getAttribute('sandbox')
  const inFrame = await page.frames().find((f) => f !== page.mainFrame()).evaluate(() => ({
    scripts: document.querySelectorAll('script').length,
    handlers: [...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => a.name.startsWith('on'))),
    frames: document.querySelectorAll('iframe,object,embed').length,
    storage: (() => { try { return typeof localStorage.length } catch { return 'blocked' } })(),
  }))
  const pwned = await page.evaluate(() => [window.__pwned, localStorage.getItem('pwned')])
  const frameUrl = page.frames().find((f) => f !== page.mainFrame()).url()
  check(frameUrl === 'about:srcdoc', `EPUB markup cannot navigate the frame away (frame at ${frameUrl})`)
  await frame.locator('#frag').click()
  await page.locator('.reader-title .t2', { hasText: 'Chapter Two' }).waitFor({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const fragFrames = page.frames().filter((f) => f !== page.mainFrame())
  const refresh = await Promise.all(fragFrames.map((f) => f.evaluate(() => document.querySelectorAll('meta[http-equiv="refresh" i]').length).catch(() => -1)))
  check(fragFrames.length > 0 && fragFrames.every((f) => f.url() === 'about:srcdoc') && refresh.every((n) => n === 0),
    `a link fragment cannot break out of the pager (frames at ${fragFrames.map((f) => f.url()).join(', ')}, refresh tags ${refresh.join(', ')})`)
  await page.locator('.reader-title').click()
  await page.keyboard.press('Home')
  await page.locator('.reader-title .t2', { hasText: 'Chapter One' }).waitFor({ timeout: 5000 })
  await frame.locator('#evil').waitFor({ timeout: 5000 })
  await page.waitForTimeout(500)
  check(sandbox === 'allow-scripts' && inFrame.storage === 'blocked', `EPUB frame is sandboxed without same-origin (${sandbox}, storage ${inFrame.storage})`)
  check(pwned[0].length === 0 && pwned[1] === null && inFrame.scripts === 1 && !inFrame.handlers && !inFrame.frames,
    `scripts in an EPUB never run (ran: ${pwned[0].join(', ') || 'none'}; ${inFrame.scripts} script, handlers ${inFrame.handlers}, frames ${inFrame.frames})`)
  for (let i = 0; i < 30; i++) {
    const [p, n] = (await pageNo.innerText()).match(/\d+/g).map(Number)
    if (p === n) break
    await page.keyboard.press('ArrowRight')
    await pageNo.filter({ hasText: new RegExp(`^Page ${p + 1} of`) }).waitFor({ timeout: 3000 }).catch(() => {})
  }
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(1500)
  const landed = (await page.locator('.reader-title .t2').innerText()).split(' · ')[0]
  check(landed === 'Chapter Two', `quick turns past a chapter's end land in the next chapter (${landed})`)
  await page.getByRole('button', { name: 'Contents' }).click()
  await page.locator('.epub-toc').getByText('Chapter Two').click()
  await page.locator('.reader-title .t2', { hasText: 'Chapter Two' }).waitFor({ timeout: 5000 })
  await page.keyboard.press('ArrowRight')
  await pageNo.filter({ hasText: /^Page 2 of/ }).waitFor({ timeout: 3000 })
  check(true, 'contents jump to a chapter')
  const before2 = await pageNo.innerText()
  await page.getByRole('button', { name: 'Larger text' }).click()
  await page.getByRole('button', { name: 'Larger text' }).click()
  check(await page.waitForFunction((b) => { const t = document.querySelector('.reader-page')?.textContent; return t && t !== b }, before2, { timeout: 5000 }).then(() => true, () => false), 'larger text repaginates the chapter')
  check(/\d+ pages? left in this chapter|Last page of this chapter/.test(await page.locator('.chapter-left').innerText().catch(() => '')), 'the reader shows pages left in the chapter')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('radio', { name: 'Paper', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.epub-frame')?.srcdoc.includes('#f4ecd8'), null, { timeout: 5000 }).catch(() => {})
  const paper = await page.evaluate(() => {
    const [r, , b] = getComputedStyle(document.querySelector('.reader')).backgroundColor.match(/\d+/g).map(Number)
    return { warm: r - b, frame: document.querySelector('.epub-frame')?.srcdoc.includes('#f4ecd8') }
  })
  check(paper.warm > 15 && paper.frame, `Paper gives the page and toolbar a warm sepia (red minus blue ${paper.warm})`)
  await page.screenshot({ path: 'test-media/shots/epub-paper.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('radio', { name: 'Day', exact: true }).click()
  const dayBg = await page.evaluate(() => getComputedStyle(document.querySelector('.reader')).backgroundColor.match(/\d+/g).slice(0, 3).reduce((a, n) => a + Number(n), 0) / 3)
  check(dayBg > 200, `Day keeps the toolbar light when the system is dark (bg ${Math.round(dayBg)})`)
  await page.setViewportSize({ width: 390, height: 844 })
  const left = await page.evaluate(() => { const e = document.querySelector('.chapter-left'); const r = e?.getBoundingClientRect(); return e ? { text: e.textContent, fits: r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight && [r.left + 2, r.right - 2].every((x) => document.elementFromPoint(x, r.top + r.height / 2)?.closest('.chapter-left') === e) } : null })
  check(!!left?.fits && /left in this chapter|Last page/.test(left.text), `pages left in the chapter show whole on a phone (${left?.text})`)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('radio', { name: 'Night', exact: true }).click()
  const chrome = await page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return (r * 299 + g * 587 + b * 114) / 1000 }
    const r = document.querySelector('.reader'), t = document.querySelector('.reader-title .t1')
    return { bg: lum(getComputedStyle(r).backgroundColor), fg: lum(getComputedStyle(t).color) }
  })
  check(chrome.bg < 40 && chrome.fg > 180, `Night darkens the reader toolbar in light mode (bg ${Math.round(chrome.bg)}, text ${Math.round(chrome.fg)})`)
  await page.screenshot({ path: 'test-media/shots/epub.png' })
  const epubUrl = page.url()
  const fresh2 = await page.context().newPage()
  fresh2.on('pageerror', (e) => errors.push(e.message))
  await fresh2.goto(epubUrl)
  check(await fresh2.locator('.reader-title .t2', { hasText: 'Chapter Two' }).waitFor({ timeout: 10000 }).then(() => true, () => false), 'EPUB reopens in the chapter it was left in')
  await fresh2.close()
  await page.goto(`${BASE}/#/`)
  check(await page.locator('.card', { hasText: 'Test Epub' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'EPUB shows in Continue')

  // A Flick server: connect through the form, see its items, play the video, read the book.
  await page.goto(`${BASE}/#/servers`)
  const flickForm = page.locator('form', { hasText: 'Flick server (NAS)' })
  await flickForm.getByLabel('Address').fill(FLICK_URL)
  await flickForm.getByLabel('Access code').fill('not-the-right-code-at-all')
  await flickForm.getByRole('button', { name: 'Connect' }).click()
  check(await flickForm.getByText('access code is wrong').waitFor({ timeout: 5000 }).then(() => true, () => false), 'Flick server form says when the code is wrong')
  await flickForm.getByLabel('Access code').fill(FLICK_CODE)
  await flickForm.getByRole('button', { name: 'Connect' }).click()
  check(await page.getByText('Smoke NAS: 5 items in your library.').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Flick server connects through the Servers form')
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Movies/ }).click()
  await page.getByText('Server Movie').first().waitFor({ timeout: 5000 })
  check(true, 'Flick server items appear in the Library')
  await page.getByText('Server Movie').first().click()
  await page.locator('.player').waitFor()
  const flickPlays = await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && v.readyState >= 2 && v.currentTime > 0.5 }, null, { timeout: 8000 }).then(() => true, () => false)
  check(flickPlays, 'video from a Flick server plays')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  await page.getByRole('tab', { name: /Books/ }).click()
  await page.getByText('Server Book').first().click()
  check(await page.locator('.reader-stage canvas').waitFor({ timeout: 15000 }).then(() => true, () => false), 'book from a Flick server opens in the reader')
  await page.goto(`${BASE}/#/library`)
  await page.getByText('Server Epub').first().click()
  await page.getByRole('button', { name: 'Contents' }).click()
  check(await page.locator('.epub-toc').getByText('Second Part').waitFor({ timeout: 10000 }).then(() => true, () => false), 'EPUB from a Flick server opens with its NCX contents')
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Audiobooks/ }).click()
  await page.getByText('Part Book').first().click()
  check(await page.getByRole('button', { name: 'Chapters (2)' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'a folder of MP3 parts on a Flick server is one audiobook, a chapter per file')
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Audiobooks/ }).click()
  await page.getByText('Server Audiobook').first().click()
  check(await page.getByRole('button', { name: 'Chapters (3)' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'an M4B on a Flick server shows its chapters')

  // The same server again, from a setup link after removing it.
  await page.goto(`${BASE}/#/servers`)
  await page.locator('.list-row', { hasText: 'Smoke NAS' }).getByRole('button', { name: 'Remove' }).click()
  await page.locator('.list-row', { hasText: 'Smoke NAS' }).waitFor({ state: 'detached' })
  const flickSetup = Buffer.from(JSON.stringify({ v: 1, servers: [{ type: 'flick', name: 'Smoke NAS', url: FLICK_URL, token: FLICK_CODE }] })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${flickSetup}`)
  await page.getByRole('button', { name: 'Connect all' }).click()
  await page.getByText('Done').waitFor()
  check(await page.locator('.list-row', { hasText: `Flick server at ${FLICK_URL}` }).getByText('5 items').isVisible(), 'setup link with a Flick server connects it')

  // Plugin sandbox: the real host page, framed the way the runtime frames it (sandbox="allow-scripts"),
  // loads plugin code over a MessagePort and cannot reach Flick's storage, page or remote modules.
  const probe = await page.evaluate(async () => {
    const code = `
      const r = {}
      const t = async (k, f) => { try { await f(); r[k] = 'reached' } catch { r[k] = 'blocked' } }
      await t('indexedDB', () => new Promise((ok, no) => { const q = indexedDB.open('flick'); q.onsuccess = ok; q.onerror = () => no(q.error) }))
      await t('localStorage', () => localStorage.getItem('flick.settings'))
      await t('cookie', () => document.cookie)
      await t('parent page', () => parent.document.title)
      await t('parent storage', () => parent.localStorage.length)
      await t('remote module', () => import('https://esm.sh/preact'))
      export default { api: 1, id: 'org.smoke.probe', name: 'Probe', version: '1', probe: r, catalogs: [], catalog() {}, meta() {}, streams() {} }`
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.hidden = true
    f.src = '/plugin-host.html'
    await new Promise((r) => { f.onload = r; document.body.appendChild(f) })
    const ch = new MessageChannel()
    f.contentWindow.postMessage({ flick: 'port' }, '*', [ch.port2])
    const reply = await new Promise((resolve) => {
      ch.port1.onmessage = (e) => { if (e.data.re === 1) resolve(e.data) }
      ch.port1.postMessage({ id: 1, m: 'load', a: [code, 'web', {}] })
      setTimeout(() => resolve({ ok: false, e: 'no answer in 10 s' }), 10000)
    })
    f.remove()
    return reply
  })
  check(probe.ok, `plugin host loads plugin code in the sandbox${probe.ok ? '' : `: ${probe.e}`}`)
  const reached = Object.entries(probe.v?.manifest?.probe ?? {}).filter(([, v]) => v !== 'blocked').map(([k]) => k)
  check(probe.ok && Object.keys(probe.v.manifest.probe).length === 6 && reached.length === 0, `a plugin cannot reach Flick's storage, page or remote modules${reached.length ? `: reached ${reached.join(', ')}` : ''}`)

  // In the apps a plugin's only network is ctx.fetch: its own fetch to a CORS-open local server is
  // refused by the app host page. The website page, as the control, reaches the same server.
  const ownFetch = (host) => page.evaluate(async ([host, target]) => {
    const code = `
      let r = 'blocked'
      try { await fetch(${JSON.stringify(target)}); r = 'reached' } catch {}
      export default { api: 1, id: 'org.smoke.net', name: 'Net', version: '1', net: r, catalogs: [], catalog() {}, meta() {}, streams() {} }`
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.hidden = true
    f.src = host
    await new Promise((r) => { f.onload = r; document.body.appendChild(f) })
    const ch = new MessageChannel()
    f.contentWindow.postMessage({ flick: 'port' }, '*', [ch.port2])
    const reply = await new Promise((resolve) => {
      ch.port1.onmessage = (e) => { if (e.data.re === 1) resolve(e.data) }
      ch.port1.postMessage({ id: 1, m: 'load', a: [code, 'desktop', {}] })
      setTimeout(() => resolve({ ok: false }), 10000)
    })
    f.remove()
    return reply.ok ? reply.v.manifest.net : 'no answer'
  }, [host, `${FLICK_URL}/api/library`])
  const webNet = await ownFetch('/plugin-host.html')
  const appNet = await ownFetch('/plugin-host-app.html')
  check(webNet === 'reached' && appNet === 'blocked', `in the apps a plugin's own fetch is refused (app page ${appNet}, website page ${webNet})`)

  // A source plugin from a URL: review first, then its page, a title page, a stream that plays.
  await page.goto(`${BASE}/#/settings`)
  const addForm = page.locator('form', { has: page.getByLabel('Plugin address') })
  await page.getByLabel('Plugin address').fill(`${FLICK_URL}/plugin.js`)
  await addForm.getByRole('button', { name: 'Add' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.waitFor({ timeout: 15000 })
  check(await sheet.getByText('Not from Flick').isVisible() && await sheet.getByText('127.0.0.1').first().isVisible(), 'review sheet shows the hosts and "Not from Flick"')
  check(await sheet.locator('.web-hosts').isVisible(), 'on the website the review sheet says the host list is not enforced')
  const count = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('plugins').objectStore('plugins').count(); q.onsuccess = () => res(q.result) } }))
  check(await count() === 0, 'nothing installs before the tap')
  await sheet.getByRole('button', { name: 'Install' }).click()
  await sheet.waitFor({ state: 'detached' })
  check(await count() === 1, 'Install saves the plugin')
  check(!(await page.locator('.nav-item', { hasText: 'Smoke Films' }).count()), 'a plugin gets no bar item')
  await page.getByRole('link', { name: 'Open Smoke Films' }).click()
  check(await page.getByText('Smoke Clip').first().waitFor({ timeout: 15000 }).then(() => true, () => false), 'plugin page shows its catalog')
  check(await page.getByText('sandbox: sealed').waitFor({ timeout: 15000 }).then(() => true, () => false), 'a plugin in the real runtime cannot reach Flick storage or the page')
  await page.screenshot({ path: 'test-media/shots/plugin-page.png' })
  await page.getByText('Smoke Clip').first().click()
  await page.locator('.stream').first().waitFor({ timeout: 15000 })
  check((await page.locator('.stream').first().innerText()).includes('Smoke stream'), 'plugin title page lists a stream')
  const qs = await page.locator('.stream-q').allInnerTexts()
  check(qs.length === 3 && /1080p/.test(qs[0]) && /SD/.test(qs[2]), `streams are grouped by quality, best first (${qs.join(' / ') || 'no groups'})`)
  check(/Play 1080p/.test(await page.locator('.play-best').innerText().catch(() => '')), 'title page offers one Play for the best stream')
  check(/HDR/.test(await page.locator('.stream').first().innerText()) && /1\.2 GB/.test(await page.locator('.stream').first().innerText()), 'a stream shows its HDR and size as tags')
  await page.screenshot({ path: 'test-media/shots/plugin-title.png' })
  await page.locator('.stream').first().click()
  await page.locator('.player').waitFor()
  check(await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && v.currentTime > 0.5 }, null, { timeout: 8000 }).then(() => true, () => false), 'a plugin stream plays in the player')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })

  // SPEC P4: Download on a direct file stream, none on an HLS playlist; the saved title plays offline.
  const dlOn = (t) => page.locator('.stream-item', { hasText: t }).locator('.stream-dl')
  check(await dlOn('Smoke stream 720p').waitFor({ timeout: 10000 }).then(() => true, () => false), 'Download shows on a direct file stream')
  check(await dlOn('Smoke stream HLS').count() === 0 && await page.locator('.stream-item', { hasText: 'Smoke stream HLS' }).count() === 1, 'no Download on an .m3u8 stream')
  await dlOn('Smoke stream 720p').click()
  check(await page.getByText('Downloaded. Plays offline.').waitFor({ timeout: 15000 }).then(() => true, () => false), 'a plugin stream downloads in the browser')
  await page.screenshot({ path: 'test-media/shots/plugin-download.png' })
  await page.context().setOffline(true)
  await page.locator('.play-best', { hasText: 'Play downloaded' }).click()
  await page.locator('.player').waitFor()
  check(await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && v.currentTime > 0.5 && v.src.startsWith('blob:') }, null, { timeout: 8000 }).then(() => true, () => false), 'the downloaded plugin title plays offline from the file')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  await page.context().setOffline(false)
  await page.getByRole('button', { name: 'Remove download' }).click()
  check(await page.locator('.play-best', { hasText: 'Play 1080p' }).waitFor({ timeout: 5000 }).then(() => true, () => false) && await dlOn('Smoke stream 720p').count() === 1, 'removing the download brings back streaming and Download')

  await page.goto(`${BASE}/#/`)
  await page.getByLabel('Search your plugins').fill('smoke')
  await page.keyboard.press('Enter')
  check(await page.locator('.row-section', { hasText: 'Smoke Films · Find' }).getByText('Smoke Clip').waitFor({ timeout: 15000 }).then(() => true, () => false), 'Home search finds titles in plugin catalogs')

  // A theme changes Flick's colors.
  await page.goto(`${BASE}/#/settings`)
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  const accent0 = await accent()
  await page.getByLabel('Plugin address').fill(`${FLICK_URL}/theme.json`)
  await addForm.getByRole('button', { name: 'Add' }).click()
  await sheet.getByRole('button', { name: 'Install' }).click()
  await page.getByLabel('Colors').selectOption('org.smoke.theme')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#2f7a4f', null, { timeout: 5000 }).catch(() => {})
  check(accent0 !== "#2f7a4f" && await accent() === "#2f7a4f", `a theme sets --accent (${accent0} -> ${await accent()})`)
  await page.screenshot({ path: 'test-media/shots/plugin-theme.png' })
  await page.getByLabel('Colors').selectOption('')

  // The Stremio plugin from Flick's list, without an account: Cinemeta rows, a title page, search.
  await page.locator('.list-row', { hasText: 'Stremio' }).getByRole('button', { name: 'Install' }).click()
  await sheet.waitFor({ timeout: 15000 })
  check(!(await sheet.getByText('Not from Flick').isVisible()), 'the Stremio plugin reviews as from Flick')
  await sheet.getByRole('button', { name: 'Install' }).click()
  await sheet.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Open Stremio' }).click()
  const firstCard = page.locator('.row-section .card:not(.skeleton)').first()
  await firstCard.waitFor({ timeout: 20000 })
  check(await page.locator('.row-section').count() > 1, `Stremio plugin shows Cinemeta rows (${await page.locator('.row-section').count()} rows)`)
  await page.screenshot({ path: 'test-media/shots/stremio.png' })
  await firstCard.click()
  await page.locator('.detail-info').waitFor({ timeout: 20000 })
  check(true, 'Stremio plugin title page opens with details')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'test-media/shots/detail.png' })
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.backdrop'), '::after').content !== 'none'), 'title page art has a scrim behind the text')
  await page.goBack()
  await page.getByLabel('Search Stremio').fill('interstellar')
  await page.keyboard.press('Enter')
  check(await page.getByText(/Interstellar/).first().waitFor({ timeout: 20000 }).then(() => true, () => false), 'Stremio plugin search finds Interstellar')
  check(await page.locator('.result-grid .card').count() > 2, `plugin search shows results as a poster grid (${await page.locator('.result-grid .card').count()} in grids)`)
  const side = await page.locator('.sidebar .nav-item:visible').allInnerTexts()
  check(side.join(',') === 'Home,Library,Settings', `desktop sidebar is Home, Library, Settings (${side.join(', ')})`)
  check(await page.locator('.nav-item.on').innerText() === 'Home', 'a plugin page sits under Home in the bar')
  const stremioPage = page.url()

  // Phone layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/#/library`)
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  check(!overflow, 'no sideways scroll at 390px')
  const firstRow = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.vgrid .card')].map((c) => c.getBoundingClientRect().top)
    return cards.filter((t) => Math.abs(t - cards[0]) < 2).length
  })
  check(firstRow >= 2, `phone library shows ${firstRow} cards a row`)
  const chipsWrap = await page.evaluate(() => { const c = [...document.querySelectorAll('.toolbar .chip')].map((e) => e.getBoundingClientRect().top); return new Set(c.map(Math.round)).size })
  check(chipsWrap === 1, `filter chips stay on one scrolling line (${chipsWrap} lines)`)
  await page.screenshot({ path: 'test-media/shots/phone-library.png' })
  await page.goto(stremioPage)
  await page.locator('.row-section .card:not(.skeleton)').first().waitFor({ timeout: 20000 })
  await page.screenshot({ path: 'test-media/shots/phone-stremio.png' })
  const bar = await page.locator('.sidebar .nav-item:visible').allInnerTexts()
  check(bar.join(',') === 'Home,Library,Settings', `phone bar is Home, Library, Settings (${bar.join(', ')})`)
  const tall = await page.locator('.sidebar .nav-item:visible').evaluateAll((l) => l.every((e) => e.getBoundingClientRect().height >= 44))
  check(tall, 'phone bar items are at least 44px tall')
  await page.locator('.nav-item', { hasText: 'Home' }).click()
  const stremioRow = page.locator('.row-section', { hasText: 'Stremio · ' }).first()
  check(await stremioRow.waitFor({ timeout: 20000 }).then(() => true, () => false), 'Home shows Stremio catalog rows titled "Stremio · <catalog>"')
  check(await stremioRow.getByRole('link', { name: 'See all' }).isVisible(), 'a Home plugin row links to See all')
  await page.screenshot({ path: 'test-media/shots/phone-home.png' })
  await page.goto(`${BASE}/#/servers`)
  await page.waitForTimeout(400)
  check(await page.locator('h1', { hasText: 'Settings' }).isVisible() && await page.evaluate(() => { const r = document.getElementById('servers')?.getBoundingClientRect(); return !!r && r.top < innerHeight && r.bottom > 0 }), '#/servers opens Settings at the Servers panel')

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await browser.close()
} finally {
  server?.kill()
  flick.close()
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1) }
console.log('\nsmoke: all checks passed')
