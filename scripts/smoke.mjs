// Headless smoke test: serves the built site, plays a real file, checks the keys,
// subtitles, saved progress, plugins (the Stremio plugin among them) and themes. Screenshots land in test-media/shots.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { make as makeAudio } from '../tests/media-setup.mjs'
import { makeEpub, EVIL } from './epub-fixture.mjs'
import { freePort } from './free-port.mjs'

const PORT = Number(process.env.SMOKE_PORT) || await freePort()
// SMOKE_BASE=https://flick-player.pages.dev checks a deployed site instead of a local build.
const BASE = process.env.SMOKE_BASE ?? `http://localhost:${PORT}`
const media = 'test-media/Sample.Clip.2023.webm'
if (!existsSync(media)) {
  mkdirSync('test-media', { recursive: true })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '20',
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
  catalogs: [{ id: 'all', name: 'Smoke catalog', type: 'movie' }, { id: 'sandbox', name: 'Sandbox report', type: 'movie' }, { id: 'find', name: 'Find', type: 'movie', search: true }, { id: 'videos', name: 'Smoke videos', type: 'video' }],
  async catalog(ctx, { id, search }) {
    if (id === 'videos') return { items: [{ id: 'vid', type: 'video', name: 'Smoke Video', posterShape: 'landscape', runtime: '1:02:05', subtitle: 'Smoke Channel', badges: ['1.2M views', '2 years ago'] }] }
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
  titleActions: [{ id: 'later', label: 'Watch later', key: 'w' }],
  async titleAction(ctx, { id }) {
    const l = (await ctx.store.get('later')) ?? []
    const on = !l.includes(id)
    await ctx.store.set('later', on ? [...l, id] : l.filter((x) => x !== id))
    return { ok: true, on, message: on ? 'Added to Watch later' : 'Removed from Watch later' }
  },
  async meta(ctx, { id }) { return { id, type: 'movie', name: 'Smoke Clip', year: '2024', description: 'A test clip.', marks: ((await ctx.store.get('later')) ?? []).includes(id) ? ['later'] : [] } },
  // One title the Flick server also has, and one only this plugin has.
  async library() { return [{ id: 'lib-sm', type: 'movie', name: 'Server Movie', year: '2024' }, { id: 'lib-only', type: 'movie', name: 'Plugin Only Film', year: '2023' }] },
  async streams(ctx, { id }) {
    await ctx.store.set('last', id)
    // Play picks the best: by language, then quality for the screen; a CAM copy never.
    if (id === 'pick') return [
      { url: '$BASE/media/a1?t=${FLICK_CODE}&s=fr', title: 'Smoke stream 1080p 🇫🇷', quality: '1080p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}&s=en', title: 'Smoke stream 720p 🇬🇧', quality: '720p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}&s=cam', title: 'Smoke stream 4K CAM 🇬🇧', quality: '4K' },
    ]
    // Japanese audio with English subtitles: the subtitles come on for an English speaker.
    if (id === 'subs') return [{ url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream 720p 🇯🇵', subs: [{ url: '$BASE/subs/en.vtt', lang: 'eng' }] }]
    // A torrent in place of a url (SPEC-torrent rule 2): the website never plays it.
    if (id === 'torrent') return [{ torrent: { infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c', fileIdx: 0 }, title: 'Smoke torrent 1080p', quality: '1080p' }]
    return [
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream SD 480p', quality: '480p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream 1080p HDR 1.2 GB', quality: '1080p' },
      { url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Smoke stream 720p', quality: '720p' },
      { url: '$BASE/media/a1/index.m3u8?t=${FLICK_CODE}', title: 'Smoke stream HLS 480p', quality: '480p' },
    ]
  },
}`
// A grid-layout plugin: For You is empty, so the page opens on Topic; Topic pages in twos.
const GRID_PLUGIN = `
const vid = (n) => ({ id: 'v' + n, type: 'video', name: 'Grid Video ' + n, posterShape: 'landscape', runtime: '4:0' + n, subtitle: 'Grid Channel' })
export default {
  api: 1, id: 'org.smoke.grid', name: 'Smoke Grid', version: '1.0.0', author: 'Smoke', hosts: ['127.0.0.1'], layout: 'grid',
  catalogs: [{ id: 'foryou', name: 'For You', type: 'video' }, { id: 'topic', name: 'Topic', type: 'video' }, { id: 'find', name: 'Find', type: 'video', search: true }],
  titleActions: [{ id: 'later', label: 'Watch later', key: 'w' }],
  async userCatalogs(ctx) { return ((await ctx.store.get('later')) ?? []).length ? [{ id: 'saved', name: 'Saved', type: 'video' }] : [] },
  async titleAction(ctx, { id }) {
    const l = (await ctx.store.get('later')) ?? []
    const on = !l.includes(id)
    await ctx.store.set('later', on ? [id, ...l] : l.filter((x) => x !== id))
    return { ok: true, on }
  },
  async catalog(ctx, { id, search, skip = 0 }) {
    // A search for "slow ..." answers late, so a newer search or a cleared box comes first.
    if (search) { if (search.startsWith('slow')) await new Promise((r) => setTimeout(r, 1500)); return { items: [{ ...vid(9), name: 'Found ' + search }] } }
    if (id === 'saved') return { items: ((await ctx.store.get('later')) ?? []).map((v) => vid(v.slice(1))) }
    if (id !== 'topic') return { items: [] }
    return { items: [1, 2, 3, 4].slice(skip, skip + 2).map(vid), more: skip + 2 < 4 }
  },
  async meta(ctx, { id }) { return { ...vid(id.slice(1)), id } },
  async streams() { return [{ url: '$BASE/media/a1?t=${FLICK_CODE}', title: 'Grid stream 720p', quality: '720p' }] },
}`

const SMOKE_THEME = {
  flick: 'theme', api: 1, id: 'org.smoke.theme', name: 'Smoke Green', version: '1.0.0', author: 'Smoke',
  light: { bg: '#f4f1ea', surface: '#ffffff', fg: '#1d2420', dim: '#5c675f', line: '#dcd6c8', accent: '#2f7a4f' },
  dark: { bg: '#101512', surface: '#18201b', fg: '#eef2ec', dim: '#9aa79d', line: '#26302a', accent: '#2f7a4f' },
}
let pluginV2 = false
const flick = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const u = new URL(req.url, 'http://x')
  const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o))
  if (u.pathname === '/api/info') return json(200, { app: 'flick-server', v: 1, name: 'Smoke NAS', version: '0.0.0' })
  if (u.pathname === '/subs/en.vtt') return res.writeHead(200, { 'content-type': 'text/vtt' }).end('WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nEnglish line\n')
  // A test source plugin and theme, installed through Settings > Plugins.
  if (u.pathname === '/plugin.js') {
    let code = SMOKE_PLUGIN.replaceAll('$BASE', `http://127.0.0.1:${flick.address().port}`)
    // Version 1.1.0 asks for one more host, so its update waits in Settings > Updates for a tap.
    if (pluginV2) code = code.replace("version: '1.0.0'", "version: '1.1.0'").replace("hosts: ['127.0.0.1']", "hosts: ['127.0.0.1', 'new.example']")
    return res.writeHead(200, { 'content-type': 'text/javascript' }).end(code)
  }
  if (u.pathname === '/grid-plugin.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(GRID_PLUGIN.replaceAll('$BASE', `http://127.0.0.1:${flick.address().port}`))
  if (u.pathname === '/theme.json') return json(200, SMOKE_THEME)
  if (u.pathname === '/shelves.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync('tests/fixtures/shelves-plugin.js'))
  // The real YouTube plugin with its desktop-only line taken out, so the website can run it (P10c case 19).
  if (u.pathname === '/youtube.js') {
    const code = readFileSync('plugins/youtube/plugin.js', 'utf8')
    if (!code.includes("  platforms: ['desktop'],\n")) return json(500, { error: 'plugins/youtube/plugin.js no longer says platforms: desktop' })
    return res.writeHead(200, { 'content-type': 'text/javascript' }).end(code.replace("  platforms: ['desktop'],\n", ''))
  }
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

// Photos: a phone folder (3 JPG, a HEIC Chrome cannot decode, an H.264 MOV), a movies-only folder,
// and a second mock server with 2,000 photos that counts thumbnail and full-size requests.
const phone = 'test-media/Phone'
rmSync(phone, { recursive: true, force: true }); mkdirSync(phone, { recursive: true })
for (const [i, c] of [[1, 'red'], [2, 'green'], [3, 'blue']]) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=1600x1200`, '-frames:v', '1', `${phone}/IMG_000${i}.JPG`])
}
writeFileSync(`${phone}/IMG_0004.HEIC`, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic'), Buffer.alloc(64)]))
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${phone}/IMG_0005.MOV`])
// One month, newest first: the MOV, then the photos, then the HEIC.
for (const [n, day] of [['IMG_0005.MOV', 7], ['IMG_0003.JPG', 6], ['IMG_0002.JPG', 5], ['IMG_0001.JPG', 4], ['IMG_0004.HEIC', 3]]) {
  const t = new Date(2026, 9, day, 12); utimesSync(`${phone}/${n}`, t, t)
}
const films = 'test-media/Films'
rmSync(films, { recursive: true, force: true }); mkdirSync(films, { recursive: true })
writeFileSync(`${films}/Heat (1995).webm`, readFileSync(media))
writeFileSync(`${films}/Heat (1995).jpg`, readFileSync(`${phone}/IMG_0001.JPG`))
writeFileSync(`${films}/fanart.jpg`, readFileSync(`${phone}/IMG_0001.JPG`))
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64', '-frames:v', '1', 'test-media/thumb.jpg'])
const smallThumb = readFileSync('test-media/thumb.jpg')
const nasHits = { thumb: 0, photoMedia: 0 }
const nasItems = Array.from({ length: 2000 }, (_, n) => ({ id: `p${n}`, folder: 'Photos', path: `Trip/IMG_${n}.jpg`, name: `IMG_${n}.jpg`, kind: 'photo', ext: 'jpg', size: 3000000, mtime: Date.UTC(2024, 0, 1) + n * 3600000 * 9 }))
// The newest item, so its tile is on the first screen.
nasItems.push({ id: 'h1', folder: 'Photos', path: 'Trip/IMG_9999.HEIC', name: 'IMG_9999.HEIC', kind: 'photo', ext: 'heic', size: 2000000, mtime: Date.UTC(2026, 5, 1), taken: '2026-06-01T09:00:00' })
const nas = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const u = new URL(req.url, 'http://x')
  const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o))
  if (u.pathname === '/api/info') return json(200, { app: 'flick-server', v: 1, name: 'Photo NAS', version: '0.0.0' })
  if (req.headers.authorization !== `Bearer ${FLICK_CODE}` && u.searchParams.get('t') !== FLICK_CODE) return json(401, { error: 'wrong code' })
  if (u.pathname === '/api/library') return json(200, { name: 'Photo NAS', folders: ['Photos'], items: nasItems })
  if (u.pathname.startsWith('/thumb/')) {
    nasHits.thumb++
    // A HEIC the server cannot thumbnail answers 415, as flick-server does.
    if (u.pathname === '/thumb/h1') return json(415, { error: 'cannot thumbnail' })
    return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(smallThumb)
  }
  if (u.pathname.startsWith('/media/')) { nasHits.photoMedia++; return json(404, { error: 'not here' }) }
  json(404, { error: 'not found' })
})
await new Promise((r) => nas.listen(0, '127.0.0.1', r))
const NAS_URL = `http://127.0.0.1:${nas.address().port}`

// Vite itself, not through npx, so kill() stops the server and no preview keeps the port.
const server = process.env.SMOKE_BASE ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const fails = []
// A step that never returns (a key press into a frame that is being replaced has done it) fails the run
// with the last check that passed, instead of hanging it. No step takes near this long.
let last = 'the start', stuck
const watch = () => {
  clearTimeout(stuck)
  stuck = setTimeout(() => { console.error(`\nsmoke: no check for 180 s after "${last}"; stopping`); server?.kill(); process.exit(1) }, 180_000)
  stuck.unref?.()
}
watch()
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails.push(what); last = what; watch() }

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/`); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  const t0 = Date.now()
  await page.goto(`${BASE}/`)
  await page.getByText('Drop anything here to play it.').waitFor()
  check(Date.now() - t0 < 3000, `first screen in ${Date.now() - t0} ms`)
  await page.screenshot({ path: 'test-media/shots/home-empty.png' })
  // SPEC-playback case 12: on the website an MKV link the browser cannot open says so at once, with no
  // spinner, and is never fetched. Chromium opens Matroska by type, so this page answers as Safari does.
  let mkvFetched = 0
  await page.route('**/never-fetched.mkv', (route) => { mkvFetched++; return route.abort() })
  await page.evaluate(() => {
    const own = HTMLMediaElement.prototype.canPlayType
    window.__ownCanPlayType = own
    HTMLMediaElement.prototype.canPlayType = function (t) { return t === 'video/x-matroska' ? '' : own.call(this, t) }
  })
  {
    await page.getByLabel('Stream URL').fill(`${BASE}/never-fetched.mkv`)
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    const card = page.locator('.player .error-card')
    check(await card.getByText('This file plays in the Flick desktop app.').waitFor({ timeout: 3000 }).then(() => true, () => false)
      && !(await page.locator('.player .status .spinner').count()) && mkvFetched === 0
      && await card.getByRole('button', { name: 'Try another source' }).isVisible(), 'a website MKV link says it plays in the desktop app, with no spinner and no fetch')
    await card.getByRole('button', { name: 'Try another source' }).click()
    await page.locator('.player').waitFor({ state: 'detached' })
    await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = window.__ownCanPlayType })
  }
  // Text that is not a link says so under the box and opens no player.
  {
    await page.getByLabel('Stream URL').fill('not a link')
    await page.getByLabel('Stream URL').press('Enter')
    check(await page.locator('.url-form + .err').getByText('That is not a link.').waitFor({ timeout: 3000 }).then(() => true, () => false)
      && !(await page.locator('.player').count()), 'text that is not a link says so under the box and opens no player')
  }
  // A link pasted and sent with Enter plays, and the player answers Space and Escape: the box behind it
  // no longer keeps the keys.
  {
    await page.route('**/pasted-link.webm', (route) => route.fulfill({ path: media, contentType: 'video/webm' }))
    await page.getByLabel('Stream URL').fill(`${BASE}/pasted-link.webm`)
    await page.getByLabel('Stream URL').press('Enter')
    await page.waitForFunction(() => (document.querySelector('.player video')?.currentTime ?? 0) > 0.5, null, { timeout: 10000 })
    await page.keyboard.press(' ')
    const paused = await page.waitForFunction(() => document.querySelector('.player video')?.paused, null, { timeout: 2000 }).then(() => true, () => false)
    await page.keyboard.press('Escape')
    const closed = await page.locator('.player').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)
    check(paused && closed, `after a pasted link, Space pauses and Escape closes the player (paused ${paused}, closed ${closed})`)
    // The steps after this expect nothing in progress yet.
    await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('flick')
      r.onsuccess = () => { const tx = r.result.transaction('progress', 'readwrite'); tx.objectStore('progress').clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }
    }))
    await page.goto(`${BASE}/#/`)
    await page.reload()
    await page.getByText('Drop anything here to play it.').waitFor()
  }
  await page.goto(`${BASE}/#/library`)
  const addBtn = page.locator('.empty .btn.primary', { hasText: 'Add a folder' })
  await addBtn.waitFor()
  const iconLook = await addBtn.evaluate((b) => { const i = b.querySelector('svg'); return { same: getComputedStyle(i).color === getComputedStyle(b).color, mid: Math.abs((i.getBoundingClientRect().top + i.getBoundingClientRect().bottom) / 2 - (b.getBoundingClientRect().top + b.getBoundingClientRect().bottom) / 2) } })
  check(iconLook.same && iconLook.mid < 1.5, `the Add a folder icon matches its label and sits centered (${JSON.stringify(iconLook)})`)
  await page.goto(`${BASE}/#/continue`)
  check(await page.getByText('Nothing to pick back up').isVisible() && await page.locator('.nav-item.on').innerText() === 'Library', 'an old #/continue link opens Library, whose empty Continue chip says how it fills')
  await page.goto(`${BASE}/#/library`)
  check(!(await page.locator('.toolbar .chip', { hasText: /^Continue/ }).count()), 'with nothing in progress Library has no Continue chip')
  await page.goto(`${BASE}/`)

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

  // Settings > Playback: languages Play picks by, in order, and what this device shows.
  await page.goto(`${BASE}/#/settings`)
  const audioList = page.getByRole('group', { name: 'Audio language' })
  await audioList.getByText('1. English').waitFor()
  const devRow = await page.locator('[data-device]').textContent()
  check(devRow.startsWith('This device: 720p, SDR'), `device row reads the 1280 px screen (${devRow})`)
  await page.getByLabel('Add to Audio language').selectOption('fr')
  await audioList.getByRole('button', { name: 'Move French up' }).click()
  await audioList.getByText('1. French').waitFor()
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('flick.settings')).audio.join() === 'fr,en'), 'audio languages save in order')
  await audioList.getByRole('button', { name: 'Remove French' }).click()
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('flick.settings')).audio.join() === 'en'), 'a language comes off the list')
  await page.screenshot({ path: 'test-media/shots/setup.png' })

  // An older setup link with Stremio addons offers the Stremio plugin in the review, and installs nothing before the tap.
  const oldCode = Buffer.from(JSON.stringify({ v: 1, stremioAddons: ['stremio://v3-cinemeta.strem.io/manifest.json'] })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${oldCode}`)
  check(await page.getByText(/Plugin: Stremio .*reaches any public website$/).waitFor({ timeout: 15000 }).then(() => true, () => false)
    && await page.getByText('Stremio addon in the Stremio plugin: https://v3-cinemeta.strem.io/manifest.json').isVisible(), 'old setup link with Stremio addons offers the Stremio plugin')
  check(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('plugins').objectStore('plugins').count(); q.onsuccess = () => res(q.result === 0) } })), 'and installs nothing before the tap')

  // Sharing this library is a desktop feature: the website has no server to run.
  await page.goto(`${BASE}/#/settings`)
  await page.getByRole('heading', { name: 'Sync across devices' }).waitFor()
  check(await page.getByText('Share this library').count() === 0, 'no Share this library section on the website')
  // Settings > Plugins starts empty, with one Add button; debrid services run only in the desktop app,
  // so the website's Add picker never offers one.
  const hub = page.locator('#plugins')
  check(await hub.getByText('Nothing connected yet').waitFor({ timeout: 5000 }).then(() => true, () => false) && await hub.getByRole('button', { name: 'Add' }).count() === 1, 'with nothing connected the hub says so and shows Add')
  await hub.getByRole('button', { name: 'Add' }).click()
  const picker = page.getByRole('dialog', { name: 'Add to Flick' })
  await picker.getByRole('button', { name: /Stremio/ }).waitFor({ timeout: 10000 })
  check(await picker.locator('.list-row', { hasText: /TorBox|Real-Debrid|AllDebrid|Premiumize/ }).count() === 0, 'the Add picker offers no debrid service on the website')
  check(await picker.getByText('Reaches any public website').isVisible() && await picker.getByText('Reaches archive.org').isVisible(), "Flick's list says what each plugin reaches")
  await picker.getByRole('link', { name: /Jellyfin or Emby/ }).click()
  check(await page.waitForURL(/#\/settings\/plugins\/new\/jellyfin$/, { timeout: 5000 }).then(() => true, () => false) && await page.getByLabel('Server address').waitFor({ timeout: 5000 }).then(() => true, () => false), 'Add > Jellyfin opens its connect page')

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
  // Escape with nothing open goes back one page, not two (the app's Back and the reader's own).
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(page.url().endsWith('#/library'), `Escape in the book reader goes back one page (${page.url().split('#')[1]})`)

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
  const listenUrl = page.url()
  await page.getByRole('button', { name: 'Speed' }).click()
  await page.locator('.listen-pop').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(await page.locator('.listen-pop').count() === 0 && page.url() === listenUrl, `Escape closes the audiobook speed menu and stays on the book (${page.url().split('#')[1]})`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(page.url().endsWith('#/library'), `Escape on the audiobook goes back one page (${page.url().split('#')[1]})`)
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
  // Every wait here is bounded: a page turn gets 15 s and the whole walk 60 s, and a timeout says what it
  // waited for and where the reader was. page.keyboard.press has no timeout of its own.
  const readerState = () => page.evaluate(() => ({
    title: document.querySelector('.reader-title .t2')?.textContent, page: document.querySelector('.reader-page')?.textContent,
    focus: document.activeElement?.className || document.activeElement?.tagName, frames: document.querySelectorAll('.epub-frame').length,
  })).then((s) => JSON.stringify(s), (e) => `unreadable (${e.message.split('\n')[0]})`)
  const walkEnds = Date.now() + 60_000
  const bounded = async (work, what) => {
    let timer
    const ms = Math.min(15_000, walkEnds - Date.now())
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('late')), Math.max(0, ms)) })
    try { return await Promise.race([work, late]) } catch (e) {
      if (e.message !== 'late') throw e
      throw new Error(`EPUB page turns: no answer in ${ms} ms while waiting for ${what}; reader ${await readerState()}`)
    } finally { clearTimeout(timer) }
  }
  for (let i = 0; i < 30; i++) {
    const [p, n] = (await bounded(pageNo.innerText({ timeout: 15_000 }), 'the page number')).match(/\d+/g).map(Number)
    if (p === n) break
    await bounded(page.keyboard.press('ArrowRight'), `ArrowRight to page ${p + 1} of ${n}`)
    await pageNo.filter({ hasText: new RegExp(`^Page ${p + 1} of`) }).waitFor({ timeout: 3000 }).catch(() => {})
  }
  // The burst goes to the reader's own key handler, the path the frame relays its keys to. A real key press
  // here lands in the chapter frame just as the first press swaps it for the next chapter, and Chrome then
  // sometimes never acknowledges the press, which hung this step for good.
  for (let i = 0; i < 4; i++) {
    await bounded(page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))), `quick turn ${i + 1} of 4`)
  }
  await page.waitForTimeout(1500)
  const landed = (await bounded(page.locator('.reader-title .t2').innerText({ timeout: 15_000 }), 'the chapter title')).split(' · ')[0]
  check(landed === 'Chapter Two', `quick turns past a chapter's end land in the next chapter (${landed})`)
  // The jump lays the chapter out again in a new frame, even to the chapter already open. Its title is
  // already Chapter Two, so the wait is for the new frame's own "Page 1 of" (#168), from a later page.
  if (/^Page 1 of/.test(await pageNo.innerText())) {
    await page.keyboard.press('ArrowRight')
    await pageNo.filter({ hasText: /^Page 2 of/ }).waitFor({ timeout: 5000 })
  }
  await page.getByRole('button', { name: 'Contents' }).click()
  await page.locator('.epub-toc').getByText('Chapter Two').click()
  await page.locator('.reader-title .t2', { hasText: 'Chapter Two' }).waitFor({ timeout: 5000 })
  await pageNo.filter({ hasText: /^Page 1 of/ }).waitFor({ timeout: 5000 })
  await page.keyboard.press('ArrowRight')
  check(await pageNo.filter({ hasText: /^Page 2 of/ }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'contents jump to a chapter')
  // A turn in the same moment as the jump waits for the new frame instead of going to the old one: the
  // page reads 1 (the new frame) and then 2 (the turn), and stays on 2.
  const seen = await page.evaluate(() => new Promise((res) => {
    const label = document.querySelector('.reader-page')
    const hist = [label.textContent]
    const mo = new MutationObserver(() => { hist.push(label.textContent) })
    mo.observe(label, { subtree: true, childList: true, characterData: true })
    ;[...document.querySelectorAll('.reader-bar button')].find((b) => b.textContent === 'Contents').click()
    setTimeout(() => {
      ;[...document.querySelectorAll('.epub-toc button')].find((b) => b.textContent === 'Chapter Two').click()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      setTimeout(() => { mo.disconnect(); res(hist.map((t) => t.replace(/ of .*/, ''))) }, 2500)
    }, 100)
  }))
  const one = seen.lastIndexOf('Page 1')
  check(one > 0 && seen.at(-1) === 'Page 2' && seen.indexOf('Page 2', one) > one, `a page turn sent with a contents jump turns the new chapter (${seen.join(', ')})`)
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
  await page.getByRole('button', { name: 'Contents' }).click()
  await page.locator('.epub-toc').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(await page.locator('.epub-toc').count() === 0 && page.url() === epubUrl, `Escape closes the EPUB contents and stays in the book (${page.url().split('#')[1]})`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(page.url().endsWith('#/library'), `Escape in the EPUB goes back one page (${page.url().split('#')[1]})`)
  await page.goto(`${BASE}/#/`)
  check(await page.locator('.card', { hasText: 'Test Epub' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'EPUB shows in Continue')

  // A Flick server: connect through the form, see its items, play the video, read the book.
  await page.goto(`${BASE}/#/settings/plugins/new/flick`)
  const flickForm = page.locator('.manage form')
  await flickForm.getByLabel('Address').fill(FLICK_URL)
  await flickForm.getByLabel('Access code').fill('not-the-right-code-at-all')
  await flickForm.getByRole('button', { name: 'Connect' }).click()
  check(await flickForm.getByText('access code is wrong').waitFor({ timeout: 5000 }).then(() => true, () => false), 'Flick server form says when the code is wrong')
  await flickForm.getByLabel('Access code').fill(FLICK_CODE)
  await flickForm.getByRole('button', { name: 'Connect' }).click()
  check(await page.getByText('Smoke NAS: 5 items in your library.').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Flick server connects through its page in Settings > Plugins')
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
  check(await page.locator('#servers .hub-row', { hasText: 'Smoke NAS' }).getByText('Flick server (NAS) · 5 items').waitFor({ timeout: 5000 }).then(() => true, () => false), 'the hub lists the server under Servers with its item count')
  await page.locator('#servers .hub-row', { hasText: 'Smoke NAS' }).click()
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Remove' }).click()
  await page.waitForURL(/#\/settings\/plugins$/)
  await page.locator('#servers').waitFor({ state: 'detached' })
  const flickSetup = Buffer.from(JSON.stringify({ v: 1, servers: [{ type: 'flick', name: 'Smoke NAS', url: FLICK_URL, token: FLICK_CODE }] })).toString('base64url')
  await page.goto(`${BASE}/#/setup?c=${flickSetup}`)
  await page.getByRole('button', { name: 'Connect all' }).click()
  await page.getByText('Done').waitFor()
  check(await page.locator('.list-row', { hasText: `Flick server at ${FLICK_URL}` }).getByText('Connected.').isVisible(), 'setup link with a Flick server connects it')
  check(await page.getByText('Smoke NAS: 5 items in your library.').waitFor({ timeout: 8000 }).then(() => true, () => false), 'and its library loads after the setup shows it')

  // Each server has its own page under Settings > Plugins; a new one starts as its connect form.
  const kvServers = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('servers'); q.onsuccess = () => res(q.result ?? []) } }))
  await page.goto(`${BASE}/#/settings/plugins/new/jellyfin`)
  await page.getByRole('heading', { name: 'Add Jellyfin or Emby' }).waitFor()
  check(await page.getByLabel('Server address').isVisible() && await page.getByLabel('Username').isVisible() && await page.getByLabel('Password').isVisible() && (await kvServers()).length === 1, 'Add > Jellyfin opens a page with address, username and password, and saves nothing yet')
  const nas = (await kvServers())[0]
  await page.goto(`${BASE}/#/settings/plugins/${encodeURIComponent(nas.id)}`)
  await page.getByRole('heading', { name: 'Smoke NAS' }).waitFor()
  check(await page.locator('.facts-list', { hasText: '5 items' }).isVisible() && await page.getByRole('button', { name: 'Sync now' }).isVisible(), 'a server page shows its item count and Sync now')
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Remove' }).click()
  check(await page.waitForURL(/#\/settings\/plugins$/, { timeout: 5000 }).then(() => true, () => false) && (await kvServers()).length === 0, 'Remove on a server page removes it and goes back to Plugins')
  await page.goto(`${BASE}/#/settings/plugins/new/flick`)
  await page.getByLabel('Address').fill(FLICK_URL)
  await page.getByLabel('Access code').fill(FLICK_CODE)
  await page.getByRole('button', { name: 'Connect' }).click()
  check(await page.waitForURL(new RegExp(`#/settings/plugins/${nas.id}$`), { timeout: 8000 }).then(() => true, () => false), 'connecting a new server opens its page')
  check(await page.locator('.facts-list', { hasText: '5 items' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'the new server page shows its items once synced')

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
  await page.goto(`${BASE}/#/settings/plugins`)
  const openAdd = async () => { await page.locator('#plugins').getByRole('button', { name: 'Add' }).click(); return page.getByRole('dialog', { name: 'Add to Flick' }) }
  const addByAddress = async (u) => { const d = await openAdd(); await d.getByLabel('Plugin address').fill(u); await d.getByRole('button', { name: 'Add', exact: true }).click() }
  await addByAddress(`${FLICK_URL}/plugin.js`)
  const sheet = page.getByRole('dialog', { name: /^(Install|Update) / })
  await sheet.waitFor({ timeout: 15000 })
  check(await sheet.getByText('Not from Flick').isVisible() && await sheet.getByText('127.0.0.1').first().isVisible(), 'review sheet shows the hosts and "Not from Flick"')
  check(await sheet.locator('.web-hosts').isVisible(), 'on the website the review sheet says the host list is not enforced')
  const count = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('plugins').objectStore('plugins').count(); q.onsuccess = () => res(q.result) } }))
  check(await count() === 0, 'nothing installs before the tap')
  await sheet.getByRole('button', { name: 'Install' }).click()
  await sheet.waitFor({ state: 'detached' })
  check(await count() === 1, 'Install saves the plugin')
  check(await page.waitForURL(/#\/settings\/plugins\/org\.smoke\.films$/, { timeout: 5000 }).then(() => true, () => false), 'a reviewed install opens the plugin page')
  await page.getByRole('heading', { name: 'Smoke Films' }).waitFor()
  check(await page.getByText('Not from Flick').isVisible() && await page.getByLabel('On').isChecked() && await page.getByText('Log', { exact: true }).isVisible(), 'a plugin page shows where it is from, its switch and its log')
  check(!(await page.locator('.nav-item', { hasText: 'Smoke Films' }).count()), 'a plugin gets no bar item')
  await page.getByRole('link', { name: 'Open Smoke Films' }).click()
  check(await page.getByText('Smoke Clip').first().waitFor({ timeout: 15000 }).then(() => true, () => false), 'plugin page shows its catalog')
  check(await page.getByText('sandbox: sealed').waitFor({ timeout: 15000 }).then(() => true, () => false), 'a plugin in the real runtime cannot reach Flick storage or the page')
  const vid = page.locator('.card', { hasText: 'Smoke Video' })
  const vidText = await vid.innerText({ timeout: 15000 }).catch(() => '')
  check(await vid.locator('.card-time').innerText().catch(() => '') === '1:02:05' && /Smoke Channel/.test(vidText) && /1\.2M views · 2 years ago/.test(vidText), `a landscape card shows its length on the thumbnail, the channel, views and age (${vidText.replace(/\n/g, ' | ')})`)
  await page.screenshot({ path: 'test-media/shots/plugin-page.png' })
  // A title action's key on a focused card acts on that card's title.
  await page.locator('.card', { hasText: 'Smoke Clip' }).first().focus()
  await page.keyboard.press('w')
  check(await page.getByText('Added to Watch later').waitFor({ timeout: 5000 }).then(() => true, () => false), 'pressing W on a focused card runs the plugin\'s Watch later action for it')
  await page.getByText('Smoke Clip').first().click()
  await page.locator('.stream').first().waitFor({ timeout: 15000 })
  check((await page.locator('.stream').first().innerText()).includes('Smoke stream'), 'plugin title page lists a stream')
  const qs = await page.locator('.stream-q').allInnerTexts()
  check(qs.length === 3 && /1080p/.test(qs[0]) && /SD/.test(qs[2]), `streams are grouped by quality, best first (${qs.join(' / ') || 'no groups'})`)
  // The smoke screen is 1280 px wide, a 720p device, so Play takes the 720p stream over 1080p HDR.
  const playLine = await page.locator('.pick-line').innerText().catch(() => '')
  check(/Play/.test(await page.locator('.play-best').innerText().catch(() => '')) && playLine === '720p', `title page offers one Play for the best stream for this screen (${playLine})`)
  check(/HDR/.test(await page.locator('.stream').first().innerText()) && /1\.2 GB/.test(await page.locator('.stream').first().innerText()), 'a stream shows its HDR and size as tags')
  // A plugin's title action: pressed state from the plugin's marks, its key on the title page.
  const later = page.getByRole('button', { name: /Watch later/ })
  check(await later.getAttribute('aria-pressed') === 'true', 'a title action set from a focused card shows pressed on the title page')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('w')
  check(await page.getByText('Removed from Watch later').waitFor({ timeout: 5000 }).then(() => true, () => false) && await later.getAttribute('aria-pressed') === 'false', 'pressing W on a title page runs the plugin\'s Watch later action')
  await page.keyboard.press('w')
  await page.getByText('Added to Watch later').waitFor({ timeout: 5000 }).catch(() => {})
  await page.reload()
  check(await later.waitFor({ timeout: 15000 }).then(async () => await later.getAttribute('aria-pressed') === 'true', () => false), 'the title page shows the action as on after a reload (the plugin\'s marks)')
  await page.screenshot({ path: 'test-media/shots/plugin-title.png' })
  await page.locator('.stream').first().click()
  await page.locator('.player').waitFor()
  check(await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && v.currentTime > 0.5 }, null, { timeout: 8000 }).then(() => true, () => false), 'a plugin stream plays in the player')
  await page.evaluate(() => { const v = document.querySelector('.player video'); v.pause(); v.currentTime = 12 })
  await page.waitForFunction(() => Math.abs(document.querySelector('.player video').currentTime - 12) < 0.5)
  await page.mouse.move(640, 400)
  await page.locator('.player').getByRole('button', { name: 'Speed' }).click()
  await page.locator('.player .pop').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check(await page.locator('.player .pop').count() === 0 && await page.locator('.player').count() === 1, 'Escape closes the player speed menu and leaves the player open')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  await page.locator('.play-best', { hasText: 'Resume' }).waitFor({ timeout: 5000 }).catch(() => {})
  const resumeLabel = await page.locator('.play-best').innerText().catch(() => '')
  check(/^Resume 0:1\d$/.test(resumeLabel.trim()) && await page.getByRole('button', { name: 'Start over' }).isVisible(), `the title page offers Resume where it was left, and Start over (${resumeLabel.trim()})`)
  const titleName = (await page.locator('h1').first().innerText()).trim()
  await page.locator('.nav-item', { hasText: 'Library' }).click()
  const firstChip = page.locator('.toolbar .chip').first()
  check(/^Continue/.test((await firstChip.innerText()).trim()), `Continue is the first Library chip (${(await firstChip.innerText()).trim()})`)
  await firstChip.click()
  const contCard = page.locator('.continue-grid .card', { hasText: titleName })
  check(await contCard.waitFor({ timeout: 5000 }).then(() => true, () => false) && await page.locator('.nav-item.on').innerText() === 'Library', `Library's Continue lists the plugin title left partway (${titleName})`)
  await page.screenshot({ path: 'test-media/shots/continue.png' })
  // A new tab has picked no chip yet, so Library opens on Continue.
  const freshTab = await page.context().newPage()
  freshTab.on('pageerror', (e) => errors.push(e.message))
  await freshTab.goto(`${BASE}/#/library`)
  check(await freshTab.locator('.continue-grid .card', { hasText: titleName }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'a fresh Library opens on Continue when something is in progress')
  await freshTab.close()
  await contCard.click()
  check(await page.locator('.play-best', { hasText: 'Resume' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'a Continue card opens the title ready to Resume')
  await page.getByRole('button', { name: 'Start over' }).click()
  await page.locator('.player').waitFor()
  await page.waitForFunction(() => document.querySelector('.player video')?.currentTime > 0.3, null, { timeout: 8000 }).catch(() => {})
  const restarted = await page.evaluate(() => document.querySelector('.player video')?.currentTime ?? -1)
  check(restarted > 0 && restarted < 5, `Start over plays from the beginning (${restarted.toFixed(1)}s)`)
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
  await page.locator('.play-best', { hasText: /downloaded/ }).click()
  await page.locator('.player').waitFor()
  check(await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && v.currentTime > 0.5 && v.src.startsWith('blob:') }, null, { timeout: 8000 }).then(() => true, () => false), 'the downloaded plugin title plays offline from the file')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  await page.context().setOffline(false)
  await page.getByRole('button', { name: 'Remove download' }).click()
  check(await page.locator('.play-best', { hasText: /Play$|Resume \d/ }).waitFor({ timeout: 5000 }).then(() => true, () => false) && await dlOn('Smoke stream 720p').count() === 1, 'removing the download brings back streaming and Download')

  // On a 1080p screen Play picks English 720p over French 1080p and an English 4K CAM, and says why.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${BASE}/#/p/org.smoke.films/movie/pick`)
  await page.reload()
  const pickLine = await page.locator('.pick-line').innerText({ timeout: 15000 }).catch(() => '')
  check(pickLine === '720p · English', `Play picks English 720p on a 1080p screen, and the line reads "720p · English" (${pickLine})`)
  await page.setViewportSize({ width: 1280, height: 800 })

  // Subtitles follow language: English listed for subtitles, Japanese audio, so English subtitles come on.
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('flick.settings') || '{}'); localStorage.setItem('flick.settings', JSON.stringify({ ...s, subs: ['en'] })) })
  await page.goto(`${BASE}/#/p/org.smoke.films/movie/subs`)
  await page.reload()
  await page.locator('.play-best').click({ timeout: 15000 })
  await page.locator('.player').waitFor()
  check(await page.waitForFunction(() => [...document.querySelector('.player video').textTracks].some((t) => t.language === 'eng' && t.mode !== 'disabled'), null, { timeout: 8000 }).then(() => true, () => false), 'English subtitles come on for Japanese audio')
  await page.keyboard.press('Escape')
  await page.locator('.player').waitFor({ state: 'detached' })
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('flick.settings')); localStorage.setItem('flick.settings', JSON.stringify({ ...s, subs: [] })) })

  // SPEC-torrent rule 29: on the website a torrent row says where it plays, offers no Download, and a tap plays nothing.
  await page.goto(`${BASE}/#/p/org.smoke.films/movie/torrent`)
  await page.reload()
  const torrentRow = page.locator('.stream-item', { hasText: 'Smoke torrent 1080p' })
  check(await torrentRow.getByText('Torrents play in the Flick desktop app with a VPN on.').waitFor({ timeout: 15000 }).then(() => true, () => false)
    && await torrentRow.locator('.stream-dl').count() === 0, 'website: a torrent row says it plays in the desktop app with a VPN on, with no Download')
  await torrentRow.locator('.stream').click({ force: true })
  check(!(await page.locator('.player').waitFor({ timeout: 1500 }).then(() => true, () => false)), 'website: tapping a torrent row plays nothing')

  await page.goto(`${BASE}/#/`)
  await page.getByLabel('Search your plugins').fill('smoke')
  await page.keyboard.press('Enter')
  check(await page.locator('.row-section', { hasText: 'Smoke Films · Find' }).getByText('Smoke Clip').waitFor({ timeout: 15000 }).then(() => true, () => false), 'Home search finds titles in plugin catalogs')
  check(await page.getByRole('button', { name: 'Search YouTube too' }).count() === 0, 'website: Home search offers no YouTube row (desktop only)')
  // The results come back after Back and after a reload, and a cleared box keeps nothing.
  {
    const found = () => page.locator('.row-section', { hasText: 'Smoke Films · Find' }).getByText('Smoke Clip').waitFor({ timeout: 15000 }).then(() => true, () => false)
    await page.goto(`${BASE}/#/library`)
    await page.goBack()
    const afterBack = await found() && await page.getByLabel('Search your plugins').inputValue() === 'smoke'
    await page.reload()
    const afterReload = await found()
    await page.getByLabel('Search your plugins').fill('')
    await page.reload()
    await page.locator('.page-head h1', { hasText: 'Home' }).waitFor()
    await page.waitForTimeout(1000)
    const cleared = await page.locator('.home-search .row-section').count() === 0 && await page.getByLabel('Search your plugins').inputValue() === ''
    check(afterBack && afterReload && cleared, `Home search results stay after Back and a reload, and a cleared box stays clear (back ${afterBack}, reload ${afterReload}, cleared ${cleared})`)
  }

  // One library: a plugin's library sits beside the server, and the same title is one card with a source choice.
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Movies/ }).click()
  const merged = page.locator('.card', { hasText: 'Server Movie' })
  check(await merged.locator('.badge', { hasText: 'Flick server · Smoke Films' }).waitFor({ timeout: 15000 }).then(() => true, () => false), 'a title on a server and in a plugin library shows both sources')
  check(await merged.count() === 1, `the same title is one card (${await merged.count()})`)
  check(await page.locator('.card', { hasText: 'Plugin Only Film' }).count() === 1, 'plugin library items are in Movies')
  await merged.click({ button: 'right' })
  check(await page.locator('.ctx').getByRole('button', { name: 'Remove from library' }).isVisible(), 'a merged card keeps the item menu')
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 400)
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Movies/ }).click()
  await merged.click()
  const srcSheet = page.getByRole("dialog", { name: "Play Server Movie from" })
  const rowsText = await srcSheet.locator(".source-row").allInnerTexts()
  check(rowsText.length === 2 && rowsText[0].startsWith('Flick server') && rowsText[1].startsWith('Smoke Films'), `source sheet lists the server, then the plugin (${rowsText.map((t) => t.split('\n')[0]).join(', ')})`)
  check(await page.evaluate(() => document.activeElement?.classList.contains('source-row') && document.activeElement.textContent.startsWith('Flick server')), 'the first source is focused')
  await page.screenshot({ path: 'test-media/shots/source-sheet.png' })
  await srcSheet.locator('.source-row', { hasText: 'Smoke Films' }).click()
  check(await page.waitForURL(/#\/p\/org\.smoke\.films\/movie\/lib-sm/, { timeout: 5000 }).then(() => true, () => false), 'choosing the plugin opens its title page')
  await page.goto(`${BASE}/#/library`)
  await page.getByRole('tab', { name: /Movies/ }).click()
  await page.locator('.card', { hasText: 'Server Movie' }).click()
  check((await page.getByRole('dialog').locator('.source-row').first().innerText()).startsWith('Smoke Films'), 'the source picked last time comes first')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  check(/#\/library$/.test(page.url()), 'Escape closes the source sheet and stays in the Library')
  await page.locator('.card', { hasText: 'Plugin Only Film' }).click()
  check(await page.waitForURL(/#\/p\/org\.smoke\.films\/movie\/lib-only/, { timeout: 5000 }).then(() => true, () => false), 'a title only in a plugin opens its title page with no sheet')

  // SPEC-library-format P10b: a plugin's shelves are Library chips, by address from tests/fixtures.
  check(await page.getByRole('tab', { name: /^Videos/ }).count() === 0, 'no Videos chip with no plugin videos')
  await page.goto(`${BASE}/#/settings/plugins`)
  await addByAddress(`${FLICK_URL}/shelves.js`)
  await sheet.getByRole('button', { name: 'Install' }).click()
  await page.waitForURL(/#\/settings\/plugins\/org\.smoke\.shelves$/, { timeout: 5000 })
  await page.goto(`${BASE}/#/library`)
  const tab = (n) => page.getByRole('tab', { name: n })
  check(await tab(/^Recipe box/).waitFor({ timeout: 15000 }).then(() => true, () => false) && await tab(/^Watch later/).count() === 1, 'shelves with items are Library chips')
  check(await tab(/^Liked/).count() === 0, 'a shelf with no items has no chip')
  await tab(/^Videos/).click()
  check(await page.locator('.card', { hasText: 'Smoke Talk' }).count() === 1, 'a plugin video is in the Videos chip')
  await tab(/^Music/).click()
  check(await page.locator('.card', { hasText: 'Smoke Song' }).count() === 1, 'a plugin song with no shelf is in Music')
  await tab(/^Watch later/).click()
  check(await page.locator('.shelf-row', { hasText: 'Smoke Talk' }).count() === 1 && await page.locator('.card').count() === 0, 'a list shelf shows rows, not a grid')
  {
    // A long list shelf keeps only the rows near the screen in the page, and scrolling shows every row.
    const seen = new Set()
    let most = 0
    for (let i = 0; i < 200; i++) {
      const s = await page.evaluate(() => {
        const m = document.querySelector('.main')
        const rows = [...document.querySelectorAll('.shelf-list .shelf-row')]
        const view = m.getBoundingClientRect()
        const shown = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > view.top && b.top < view.bottom }).map((r) => r.querySelector('.t1').textContent)
        const end = m.scrollTop + m.clientHeight >= m.scrollHeight - 4
        m.style.scrollBehavior = 'auto'; m.scrollTop += m.clientHeight / 2
        return { n: rows.length, shown, end }
      })
      most = Math.max(most, s.n)
      s.shown.forEach((t) => seen.add(t))
      if (s.end) break
      await page.waitForTimeout(30)
    }
    check(seen.size === 301 && most < 100, `a 301 row list shelf scrolls through every row with few in the page (${seen.size} seen, at most ${most} at once)`)
    await page.evaluate(() => { document.querySelector('.main').scrollTop = 0 })
  }
  // A sort picked on one tab stays there: a shelf opens in its own order until it is sorted itself.
  const sortBox = page.getByLabel('Sort')
  await tab(/^All/).click()
  await sortBox.selectOption('title')
  await tab(/^Recipe box/).click()
  const shelfSort = await sortBox.inputValue()
  await sortBox.selectOption('year')
  await tab(/^All/).click()
  const allSort = await sortBox.inputValue()
  await tab(/^Recipe box/).click()
  const backSort = await sortBox.inputValue()
  check(shelfSort === '' && allSort === 'title' && backSort === 'year', `a sort picked on All does not carry into a shelf, and a shelf keeps its own (shelf ${shelfSort || 'Shelf order'}, All ${allSort}, shelf again ${backSort})`)
  await tab(/^All/).click()
  await sortBox.selectOption('added')
  await page.getByLabel('Search library').fill('Switch')
  check(await page.locator('.card', { hasText: 'Smoke Pancakes' }).waitFor({ timeout: 5000 }).then(() => true, () => false) && await page.locator('.card').count() === 1, 'Library search finds a plugin item by a fact value')
  await page.getByLabel('Search library').fill('')
  await tab(/^Recipe box/).click()
  await page.reload()
  check(await page.getByRole('tab', { name: /^Recipe box/, selected: true }).waitFor({ timeout: 15000 }).then(() => true, () => false), 'a shelf chip picked before a reload is picked after it')
  await page.locator('.card', { hasText: 'Smoke Pancakes' }).click()
  await page.getByRole('heading', { name: 'Smoke Pancakes' }).waitFor({ timeout: 15000 })
  const facts = await page.locator('.title-facts > div').allInnerTexts()
  check(facts.length === 8 && /Servings\s+4/.test(facts[0]), `a title page lists the first 8 facts (${facts.length})`)
  await page.waitForTimeout(500)
  check(await page.locator('.streams').count() === 0, 'a kind of its own with no streams shows no Streams section')
  // A Like through the plugin's action shows on the Liked shelf at once, inside the 5 minute cache.
  await page.goto(`${BASE}/#/settings/plugins/org.smoke.shelves`)
  await page.getByRole('button', { name: 'Like Smoke Pancakes' }).click()
  await page.getByText('Liked', { exact: true }).waitFor({ timeout: 10000 })
  await page.locator('.nav-item', { hasText: 'Library' }).click()
  check(await tab(/^Liked/).waitFor({ timeout: 10000 }).then(() => true, () => false), 'after an action the Liked chip shows with no reload')
  // SPEC-library-format case 19: Like on a YouTube title puts it on the Liked chip with no reload.
  // The plugin is the real one; YouTube's oEmbed answer comes from here, never from YouTube.
  await page.route(/^https:\/\/www\.youtube\.com\/oembed/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ title: 'Smoke YouTube Talk', author_name: 'Smoke Tube' }) }))
  await page.goto(`${BASE}/#/settings/plugins`)
  await addByAddress(`${FLICK_URL}/youtube.js`)
  await sheet.getByRole('button', { name: 'Install' }).click()
  await page.waitForURL(/#\/settings\/plugins\/com\.youtube$/, { timeout: 5000 })
  await page.goto(`${BASE}/#/p/com.youtube/video/${encodeURIComponent('https://www.youtube.com/watch?v=smokeTube01')}`)
  await page.getByRole('heading', { name: 'Smoke YouTube Talk' }).waitFor({ timeout: 15000 })
  const like = page.locator('.title-acts button', { hasText: /^Like/ })
  await like.click()
  await page.locator('.title-acts button[aria-pressed="true"]', { hasText: /^Like/ }).waitFor({ timeout: 10000 })
  await page.locator('.nav-item', { hasText: 'Library' }).click()
  await tab(/^Liked/).click()
  check(await page.locator('.card', { hasText: 'Smoke YouTube Talk' }).waitFor({ timeout: 10000 }).then(() => true, () => false), 'Like on a YouTube title shows it on the Liked chip with no reload')
  check(await page.locator('.card', { hasText: 'Smoke Pancakes' }).count() === 1, "YouTube's Liked and another plugin's Liked are one chip")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const row = await page.evaluate(() => { const c = document.querySelector('.toolbar .chips'); return { page: document.documentElement.scrollWidth, chips: c.scrollWidth > c.clientWidth, n: document.querySelectorAll('.toolbar .chip').length } })
  check(row.page <= 390 && row.chips && row.n >= 24, `390 px with 20 shelf chips: no sideways page scroll, the chips scroll in their row (${JSON.stringify(row)})`)
  await page.screenshot({ path: 'test-media/shots/library-shelves-phone.png' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await tab(/^All/).click()

  // A theme changes Flick's colors.
  await page.goto(`${BASE}/#/settings/plugins`)
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  const accent0 = await accent()
  await addByAddress(`${FLICK_URL}/theme.json`)
  await sheet.getByRole('button', { name: 'Install' }).click()
  await page.waitForURL(/#\/settings\/plugins\/org\.smoke\.theme$/, { timeout: 5000 })
  await page.goto(`${BASE}/#/settings`)
  await page.getByLabel('Colors').selectOption('org.smoke.theme')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#2f7a4f', null, { timeout: 5000 }).catch(() => {})
  check(accent0 !== "#2f7a4f" && await accent() === "#2f7a4f", `a theme sets --accent (${accent0} -> ${await accent()})`)
  await page.screenshot({ path: 'test-media/shots/plugin-theme.png' })
  await page.getByLabel('Colors').selectOption('')

  // Settings > Updates on the website: no app updater, and a plugin update with a new host waits for Allow.
  const updatesPanel = page.locator('#updates')
  check(await updatesPanel.getByText('The website updates itself').isVisible() && await updatesPanel.getByRole('button', { name: 'Restart to update' }).count() === 0, 'Updates panel renders on the website without the app part')
  pluginV2 = true
  await updatesPanel.getByRole('button', { name: 'Check now' }).click()
  const waiting = updatesPanel.locator('.update-plugin', { hasText: 'Smoke Films 1.1.0 asks to reach new.example' })
  check(await waiting.waitFor({ timeout: 10000 }).then(() => true, () => false), 'a plugin update with a new host is listed in Updates')
  await waiting.getByRole('button', { name: 'Allow' }).click()
  check(await waiting.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false), 'Allow installs the plugin update')
  await page.screenshot({ path: 'test-media/shots/updates.png' })

  // The Stremio plugin from Flick's list, without an account: Cinemeta rows, a title page, search.
  await (await openAdd()).getByRole('button', { name: /Stremio/ }).click()
  check(await page.waitForURL(/#\/settings\/plugins\/dev\.flick\.stremio$/, { timeout: 15000 }).then(() => true, () => false) && !(await sheet.count()), "Add > Stremio installs with no review sheet and opens Stremio's page")
  check(await page.getByRole('button', { name: 'Sign in to Stremio' }).isVisible(), "Stremio's page offers Sign in to Stremio")
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

  // Stremio's Addons on its own page (SPEC-plugins-hub rule 10), signed out: Cinemeta built in, add by
  // address with one confirm, Browse, Remove. Stremio's addon catalog and Torrentio answer from
  // tests/fixtures/stremio/addons.json, so none of those requests leave this machine.
  const stremioFx = JSON.parse(readFileSync('tests/fixtures/stremio/addons.json', 'utf8'))
  const fxAddons = [...stremioFx.official.addons, ...stremioFx.community.addons]
  await page.route(/^https:\/\/(v3-cinemeta\.strem\.io\/addon_catalog\/|torrentio\.strem\.fun\/|torrent-catalogs\.strem\.fun\/)/, (route) => {
    const u = route.request().url()
    const body = u.endsWith('/official.json') ? stremioFx.official : u.endsWith('/community.json') ? stremioFx.community
      : /^https:\/\/torrentio\.strem\.fun\/.*manifest\.json$/.test(u) ? stremioFx.torrentio : fxAddons.find((a) => a.transportUrl === u)?.manifest
    return route.fulfill({ status: body ? 200 : 404, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
  })
  await page.goto(`${BASE}/#/settings/plugins/dev.flick.stremio`)
  const addonsSec = page.getByRole('region', { name: 'Addons' })
  const named = (name) => addonsSec.locator('.ext-row', { has: page.getByText(name, { exact: true }) })
  const cineRow = named('Cinemeta')
  const cineOk = await cineRow.waitFor({ timeout: 20000 }).then(() => true, () => false) && await cineRow.getByRole('button', { name: /Remove/ }).count() === 0
  check(cineOk, `Stremio's page lists Cinemeta under Addons with no Remove${cineOk ? '' : `: ${JSON.stringify(await page.locator('main').innerText())}`}`)
  await addonsSec.getByLabel('Addon address').fill('http://torrentio.strem.fun/manifest.json')
  await addonsSec.getByRole('button', { name: 'Add', exact: true }).click()
  check(await page.getByText(/must start with https:\/\/ or stremio:\/\//).first().waitFor({ timeout: 10000 }).then(() => true, () => false)
    && !(await page.getByRole('dialog', { name: /^Add / }).count()), 'an http:// addon address is refused with no confirm')
  await addonsSec.getByLabel('Addon address').fill('stremio://torrentio.strem.fun/torbox=abc123XYZ9/manifest.json')
  await addonsSec.getByRole('button', { name: 'Add', exact: true }).click()
  const addSheet = page.getByRole('dialog', { name: 'Add Torrentio' })
  await addSheet.waitFor({ timeout: 15000 })
  const sheetText = await addSheet.innerText()
  check(sheetText.includes('Movies') && sheetText.includes('torrentio.strem.fun') && sheetText.includes('torbox=\u2022\u2022\u2022XYZ9') && !sheetText.includes('abc123XYZ9'), 'adding Torrentio by address shows what it provides, its host and a masked key first')
  check(!(await named('Torrentio').count()), 'nothing is added before the tap')
  await addSheet.getByRole('button', { name: 'Add', exact: true }).click()
  await addSheet.waitFor({ state: 'detached' })
  const torRow = named('Torrentio')
  check(await torRow.waitFor({ timeout: 15000 }).then(() => true, () => false) && (await torRow.innerText()).includes('\u2022\u2022\u2022XYZ9') && !(await torRow.innerText()).includes('abc123XYZ9'), 'the added addon is listed with its key masked')
  const savedList = page.getByRole('group', { name: 'Extra addon URLs' })
  const savedText = await savedList.innerText().catch(() => '')
  check(savedText.includes('torrentio.strem.fun') && savedText.includes('\u2022\u2022\u2022XYZ9') && !savedText.includes('abc123XYZ9')
    && await page.locator('.plugin-form textarea').count() === 0, `the settings form shows the addon Stremio saved, its key masked and not as raw text (${JSON.stringify(savedText)})`)
  await addonsSec.getByRole('button', { name: 'Browse addons' }).click()
  await addonsSec.getByLabel('Search addons').fill('torrentio')
  const catRow = addonsSec.locator('.ext-browse .ext-row', { has: page.getByText('Torrent Catalogs', { exact: true }) })
  check(await catRow.waitFor({ timeout: 15000 }).then(() => true, () => false)
    && await page.waitForFunction(() => document.querySelectorAll('.ext-browse .ext-row').length === 1, null, { timeout: 5000 }).then(() => true, () => false), "Browse searches Stremio's addon catalog")
  await page.setViewportSize({ width: 390, height: 844 })
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the Addons section fits a phone without sideways scroll')
  await page.screenshot({ path: 'test-media/shots/stremio-addons-phone.png' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await catRow.getByRole('button', { name: 'Add Torrent Catalogs' }).click()
  await page.getByRole('dialog', { name: 'Add Torrent Catalogs' }).getByRole('button', { name: 'Add', exact: true }).click()
  check(await catRow.getByText('Added').waitFor({ timeout: 15000 }).then(() => true, () => false)
    && await addonsSec.locator('.ext-row:not(.ext-browse .ext-row)', { has: page.getByText('Torrent Catalogs', { exact: true }) }).count() === 1, 'Browse adds after the confirm and marks it Added')
  page.once('dialog', (d) => d.accept())
  await torRow.getByRole('button', { name: 'Remove Torrentio' }).click()
  check(await torRow.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false), 'Remove takes the addon out')
  await page.screenshot({ path: 'test-media/shots/stremio-addons.png' })
  // Leave Stremio as it was, so later steps never ask Torrent Catalogs for rows. This remove goes through
  // the settings form, the one place an entry that no longer loads can still be removed.
  await page.getByRole('group', { name: 'Extra addon URLs' }).getByRole('button', { name: /^Remove entry 1, https:\/\/torrent-catalogs/ }).click()
  await page.getByRole('button', { name: 'Save settings' }).click()
  check(await addonsSec.locator('.ext-row:not(.ext-browse .ext-row)', { has: page.getByText('Torrent Catalogs', { exact: true }) }).waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false)
    && await catRow.getByRole('button', { name: 'Add Torrent Catalogs' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'Remove in the settings form takes an entry out, and Browse offers Add again')
  await page.unroute(/^https:\/\/(v3-cinemeta\.strem\.io\/addon_catalog\/|torrentio\.strem\.fun\/|torrent-catalogs\.strem\.fun\/)/)

  // Phone layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/#/library`)
  await page.waitForTimeout(400)
  await page.locator('.toolbar .chip', { hasText: /^All/ }).click()
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
  // Preact runs a closed screen's effect cleanups after the next paint, so the grid's scroll listener outlives
  // the grid for a moment. A pane scroll in that moment must not reach the grid that is gone.
  const lateScroll = await page.evaluate(async () => {
    const errs = []
    const on = (e) => errs.push(e.message)
    addEventListener('error', on)
    const moved = new Promise((r) => addEventListener('hashchange', r, { once: true }))
    location.hash = '#/settings'
    await moved
    for (let i = 0; i < 50 && document.querySelector('.vgrid'); i++) await Promise.resolve()
    const gone = !document.querySelector('.vgrid')
    document.querySelector('.main')?.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 50))
    removeEventListener('error', on)
    return { gone, errs }
  })
  check(lateScroll.gone && lateScroll.errs.length === 0, `a pane scroll as Library closes does not reach the closed grid (${lateScroll.gone ? lateScroll.errs.join(' | ') || 'no error' : 'grid still shown'})`)
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
  check(await page.locator('h1', { hasText: 'Settings' }).isVisible() && await page.evaluate(() => { const r = document.getElementById('servers')?.getBoundingClientRect(); return !!r && r.top < innerHeight && r.bottom > 0 }), '#/servers opens Settings at the Servers group of Plugins')
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.hub-row, .add-sheet')].some((e) => e.getBoundingClientRect().right > innerWidth + 1))
  check(!(await wide()) && await page.locator('#plugins .hub-row').count() >= 3, 'phone: the hub rows fit at 390px with no sideways scroll')
  await page.locator('#plugins').getByRole('button', { name: 'Add' }).click()
  await page.getByRole('dialog', { name: 'Add to Flick' }).getByText('Internet Archive').waitFor({ timeout: 10000 })
  check(!(await wide()), 'phone: the Add picker fits at 390px')
  await page.screenshot({ path: 'test-media/shots/phone-add.png' })
  await page.keyboard.press('Escape')

  // A grid-layout plugin page, in a fresh context: chips, a grid, Show more, / to search, arrows, Enter to play.
  {
    const gp = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    gp.on('pageerror', (e) => errors.push(e.message))
    await gp.goto(`${BASE}/#/settings/plugins`)
    await gp.locator('#plugins').getByRole('button', { name: 'Add' }).click()
    const add = gp.getByRole('dialog', { name: 'Add to Flick' })
    await add.getByLabel('Plugin address').fill(`${FLICK_URL}/grid-plugin.js`)
    await add.getByRole('button', { name: 'Add', exact: true }).click()
    const review = gp.getByRole('dialog', { name: /^Install / })
    await review.getByRole('button', { name: 'Install' }).click()
    await review.waitFor({ state: 'detached' })
    await gp.goto(`${BASE}/#/p/org.smoke.grid`)
    const cards = gp.locator('.video-grid button.card')
    await cards.first().waitFor({ timeout: 15000 }).catch(() => {})
    const chips = await gp.locator('.chips [role=tab]').allInnerTexts()
    const on = await gp.locator('.chips [role=tab][aria-selected=true]').innerText().catch(() => '')
    check(chips.join() === 'For You,Topic' && on === 'Topic' && await cards.count() === 2, `a grid plugin page shows one chip per catalog and opens on the first with titles (${chips.join(', ')}; on ${on}; ${await cards.count()} cards)`)
    await gp.getByRole('button', { name: 'Show more' }).click()
    check(await cards.nth(3).waitFor({ timeout: 5000 }).then(() => true, () => false) && !(await gp.getByRole('button', { name: 'Show more' }).count()), 'Show more adds the next page and goes when there is no more')
    await gp.evaluate(() => document.activeElement?.blur())
    await gp.keyboard.press('/')
    check(await gp.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search Smoke Grid', '/ focuses the plugin page search')
    await gp.keyboard.type('cats')
    await gp.keyboard.press('Enter')
    check(await gp.locator('.video-grid .card', { hasText: 'Found cats' }).waitFor({ timeout: 10000 }).then(() => true, () => false), 'grid plugin search shows its results as a grid')
    // Each search is numbered and an answer from an older one is dropped: the box shows only the newest
    // search's results, and a cleared box shows none, however late the older answer lands.
    const box = gp.getByLabel('Search Smoke Grid')
    const lateSearch = async (results, after) => {
      await box.fill('slow one'); await box.press('Enter')
      await gp.waitForTimeout(200)
      await after()
      await gp.waitForTimeout(2500)
      return results().allInnerTexts()
    }
    const plNewer = await lateSearch(() => gp.locator('.video-grid .card .t1'), async () => { await box.fill('cats two'); await box.press('Enter') })
    const plCleared = await lateSearch(() => gp.locator('.video-grid .card .t1', { hasText: /^Found/ }), () => box.fill(''))
    check(plNewer.join() === 'Found cats two' && plCleared.length === 0, `a plugin page shows only its newest search, and nothing late after a clear (${plNewer.join(', ')}; cleared: ${plCleared.join(', ') || 'none'})`)
    await gp.goto(`${BASE}/#/`)
    const homeBox = gp.getByLabel('Search your plugins')
    const homeLate = async (after) => {
      await homeBox.fill('slow one'); await homeBox.press('Enter')
      await gp.waitForTimeout(200)
      await after()
      await gp.waitForTimeout(2500)
      return gp.locator('.home-search .card .t1').allInnerTexts()
    }
    const homeNewer = await homeLate(async () => { await homeBox.fill('cats two'); await homeBox.press('Enter') })
    const homeCleared = await homeLate(() => homeBox.fill(''))
    check(homeNewer.join() === 'Found cats two' && homeCleared.length === 0, `Home search shows only its newest search, and nothing late after a clear (${homeNewer.join(', ')}; cleared: ${homeCleared.join(', ') || 'none'})`)
    await gp.goto(`${BASE}/#/p/org.smoke.grid`)
    await gp.getByLabel('Search Smoke Grid').fill('')
    await cards.first().waitFor({ timeout: 10000 })
    await cards.first().focus()
    await gp.keyboard.press('ArrowRight')
    check(await gp.evaluate(() => document.activeElement?.textContent ?? '').then((t) => /Grid Video 2/.test(t)), 'the arrow keys move between grid cards')
    await gp.keyboard.press('w')
    check(await gp.locator('.chips [role=tab]', { hasText: 'Saved' }).waitFor({ timeout: 5000 }).then(() => true, () => false), "W on a grid card shows the plugin's new list chip at once, with no reload")
    await gp.keyboard.press('Enter')
    await gp.locator('.streams .play-best').waitFor({ timeout: 15000 })
    check(await gp.waitForFunction(() => document.activeElement?.classList.contains('play-best'), null, { timeout: 5000 }).then(() => true, () => false), 'a title opened from a grid has Play focused')
    await gp.keyboard.press('Enter')
    check(await gp.locator('.player').waitFor({ timeout: 10000 }).then(() => true, () => false), 'Enter on that title plays it')
    await gp.keyboard.press('Escape')
    await gp.setViewportSize({ width: 390, height: 844 })
    await gp.goto(`${BASE}/#/p/org.smoke.grid`)
    await cards.first().waitFor({ timeout: 15000 })
    check(await gp.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.video-grid .card')].every((c) => c.getBoundingClientRect().right <= innerWidth)), 'the grid fits a 390 px phone with no sideways scroll')
    await gp.screenshot({ path: 'test-media/shots/plugin-grid-phone.png' })
    await gp.context().close()
  }

  // Photos, in fresh contexts so nothing else is in the library. The folder is added the way Safari and
  // Firefox do it (a directory input), which hands Flick the files themselves.
  const photoPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await ctx.addInitScript(() => { delete window.showDirectoryPicker })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    return p
  }
  const addDir = async (p, dir) => {
    await p.goto(`${BASE}/#/library`)
    const ch = p.waitForEvent('filechooser')
    await p.getByRole('button', { name: 'Add folder' }).first().click()
    await (await ch).setFiles(dir)
  }
  const pp = await photoPage()
  await addDir(pp, phone)
  const photosTab = pp.getByRole('tab', { name: /Photos/ })
  check(await photosTab.waitFor({ timeout: 10000 }).then(() => true, () => false) && /5/.test(await photosTab.innerText()), 'a phone folder gets a Photos tab with 5 items')
  await photosTab.click()
  await pp.locator('.photo-tile img').nth(2).waitFor({ timeout: 10000 })
  check(await pp.locator('.photos-month').count() === 1 && await pp.locator('.photo-tile').count() === 5, 'the 5 phone items are one month group')
  // The three photo tiles once their thumbnails have loaded (the video's tile has a play badge).
  const tileSizes = await pp.waitForFunction(() => {
    const w = [...document.querySelectorAll('.photo-tile img')].filter((i) => !i.closest('.photo-tile').querySelector('.photo-play')).map((i) => i.naturalWidth)
    return w.length === 3 && w.every((x) => x > 0) && w
  }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => [])
  check(tileSizes.length === 3 && tileSizes.every((w) => w > 0 && w <= 480), `photo tiles are small thumbnails (${tileSizes.join(', ')} px wide)`)
  check(await pp.locator('.photo-file', { hasText: 'IMG_0004' }).waitFor({ timeout: 10000 }).then(() => true, () => false), 'a HEIC the browser cannot show is a file tile with its name')
  check(await pp.getByRole('tab', { name: /^All/ }).innerText().then((t) => /\b1\b/.test(t)), 'photos are not in All, only the phone video is')
  await pp.locator('.photo-tile').first().click()
  const movPlays = await pp.waitForFunction(() => { const v = document.querySelector('.photo-viewer video'); return v && v.readyState >= 2 && v.currentTime > 0.3 }, null, { timeout: 10000 }).then(() => true, () => false)
  check(movPlays, 'the phone MOV plays inline in the photo viewer')
  await pp.keyboard.press('ArrowRight')
  const full = await pp.waitForFunction(() => document.querySelector('.photo-viewer img')?.naturalWidth ?? 0, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => 0)
  check(full === 1600 && /2 of 5/.test(await pp.locator('.photo-viewer-bar').innerText()), `ArrowRight shows the next photo at full size (${full} px)`)
  await pp.mouse.move(900, 400); await pp.mouse.down(); await pp.mouse.move(600, 400, { steps: 5 }); await pp.mouse.up()
  check(/3 of 5/.test(await pp.locator('.photo-viewer-bar').innerText()), 'a swipe moves to the next photo')
  check(await pp.evaluate(() => !!document.activeElement?.closest('.photo-viewer')), 'focus is inside the open viewer')
  await pp.keyboard.press(' ')
  await pp.waitForTimeout(200)
  check(/3 of 5/.test(await pp.locator('.photo-viewer-bar').innerText()) && await pp.locator('.photo-viewer').count() === 1, 'Space in the viewer never acts on the grid behind it')
  await pp.keyboard.press('Tab'); await pp.keyboard.press('Tab'); await pp.keyboard.press('Tab')
  await pp.keyboard.press('Shift+Tab'); await pp.keyboard.press('Shift+Tab')
  check(await pp.evaluate(() => !!document.activeElement?.closest('.photo-viewer')), 'Tab and Shift+Tab stay inside the viewer')
  await pp.screenshot({ path: 'test-media/shots/photo-viewer.png' })
  await pp.keyboard.press('Escape')
  check(await pp.locator('.photo-viewer').count() === 0 && pp.url().endsWith('#/library'), 'Escape closes the viewer and stays in the Library')
  await pp.screenshot({ path: 'test-media/shots/photos.png' })
  await pp.context().close()

  const mp = await photoPage()
  await addDir(mp, films)
  await mp.getByText('Heat').first().waitFor({ timeout: 10000 })
  check(await mp.getByRole('tab', { name: /Photos/ }).count() === 0, 'a folder of movies and their posters has no Photos tab')
  await mp.context().close()

  const np = await photoPage()
  const nasSetup = Buffer.from(JSON.stringify({ v: 1, servers: [{ type: 'flick', name: 'Photo NAS', url: NAS_URL, token: FLICK_CODE }] })).toString('base64url')
  await np.goto(`${BASE}/#/setup?c=${nasSetup}`)
  await np.getByRole('button', { name: 'Connect all' }).click()
  await np.getByText('Done').waitFor()
  await np.goto(`${BASE}/#/library`)
  check(await np.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.startsWith('Photos'), null, { timeout: 5000 }).then(() => true, () => false), 'a library of only photos opens on the Photos tab')
  await np.locator('.photo-tile img').first().waitFor({ timeout: 10000 })
  check(/2001/.test(await np.getByRole('tab', { name: /Photos/ }).innerText()), 'a flick-server share lists its photos')
  await np.waitForTimeout(500)
  const firstScreen = nasHits.thumb
  check(firstScreen > 0 && firstScreen < 200, `the first screen asks the server for ${firstScreen} thumbnails, not 2,000`)
  check(await np.locator('.photo-file', { hasText: 'IMG_9999' }).waitFor({ timeout: 15000 }).then(() => true, () => false), 'a server HEIC with no thumbnail is a file tile')
  let most = 0
  const atEnd = async () => np.evaluate(() => { const m = document.querySelector('.main'); return m.scrollTop + m.clientHeight >= m.scrollHeight - 4 })
  for (let y = 0; y < 200 && !(await atEnd()); y++) {
    await np.evaluate(() => { const m = document.querySelector('.main'); m.style.scrollBehavior = 'auto'; m.scrollTop += m.clientHeight })
    await np.waitForTimeout(60)
    most = Math.max(most, await np.locator('.photo-tile').count())
  }
  await np.waitForTimeout(500)
  check(await atEnd() && nasHits.photoMedia === 0 && most < 400, `2,000 photos scroll to the end with no full-size loads (${nasHits.thumb} thumbnails, ${nasHits.photoMedia} full files, at most ${most} tiles at once)`)
  await np.context().close()

  // A scroll moves the grid's window over the list. Each card then shows its own item's poster, never
  // the poster of the item that card showed before; a track with no poster shows none.
  const gp = await photoPage()
  await gp.goto(`${BASE}/#/library`)
  await gp.waitForTimeout(500)
  await gp.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('flick')
    r.onsuccess = () => {
      const tx = r.result.transaction(['items', 'thumbs', 'kv'], 'readwrite')
      for (let n = 0; n < 120; n++) {
        const id = `grid-${n}`
        tx.objectStore('items').put({ id, title: `Grid track ${n}`, kind: 'audio', src: { t: 'url', url: `http://127.0.0.1:9/${id}.mp3` }, origin: 'local', size: 1, mtime: 0, addedAt: 1000 - n }, id)
        if (n % 3 === 0) tx.objectStore('thumbs').put(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><desc>${id}</desc></svg>`], { type: 'image/svg+xml' }), id)
      }
      const kv = tx.objectStore('kv')
      const rev = kv.get('items.rev')
      rev.onsuccess = () => kv.put((rev.result ?? 0) + 1, 'items.rev')
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    }
  }))
  await gp.reload()
  await gp.locator('.vgrid .card').first().waitFor({ timeout: 10000 })
  // A poster that loads on screen fades in; one that loads in a row drawn ahead of the scroll shows at once.
  await gp.waitForTimeout(800)
  const fades = await gp.evaluate(() => [...document.querySelectorAll('.vgrid .card .art img.in')].map((img) => {
    const r = img.getBoundingClientRect()
    return { on: r.bottom > 0 && r.top < innerHeight, now: img.classList.contains('now') }
  }))
  const onScreen = fades.filter((f) => f.on), ahead = fades.filter((f) => !f.on)
  check(onScreen.length > 0 && ahead.length > 0 && onScreen.every((f) => !f.now) && ahead.every((f) => f.now), `posters on screen fade in and posters loaded below the fold do not (${onScreen.filter((f) => !f.now).length}/${onScreen.length} on screen fade, ${ahead.filter((f) => f.now).length}/${ahead.length} below show at once)`)
  const wrongArt = []
  const gridAtEnd = () => gp.evaluate(() => { const m = document.querySelector('.main'); return m.scrollTop + m.clientHeight >= m.scrollHeight - 4 })
  for (let y = 0; y < 40 && !(await gridAtEnd()); y++) {
    await gp.evaluate(() => { const m = document.querySelector('.main'); m.style.scrollBehavior = 'auto'; m.scrollTop += m.clientHeight / 2 })
    await gp.waitForTimeout(250)
    wrongArt.push(...await gp.evaluate(() => Promise.all([...document.querySelectorAll('.vgrid .card')].map(async (c) => {
      const n = Number(c.getAttribute('title').replace('Grid track ', ''))
      const img = c.querySelector('.art img')
      const shown = img ? (await (await fetch(img.src)).text()).match(/<desc>(.*)<\/desc>/)?.[1] : null
      const want = n % 3 === 0 ? `grid-${n}` : null
      return shown === want ? null : `track ${n} shows ${shown ?? 'no poster'}`
    })).then((l) => l.filter(Boolean))))
  }
  check(await gridAtEnd() && wrongArt.length === 0, `each grid card keeps its own poster as the grid scrolls (${[...new Set(wrongArt)].slice(0, 4).join('; ') || 'all match'})`)
  await gp.context().close()

  // Escape closes the newest open menu or sheet and stops there; with nothing open it goes back one page.
  {
    const ep = await photoPage()
    await ep.goto(`${BASE}/#/settings`)
    await ep.goto(`${BASE}/#/library`)
    await ep.waitForTimeout(500)
    await ep.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('flick')
      r.onsuccess = () => {
        const tx = r.result.transaction(['items', 'kv'], 'readwrite')
        tx.objectStore('items').put({ id: 'menu-1', title: 'Menu track', kind: 'audio', src: { t: 'url', url: 'http://127.0.0.1:9/menu.mp3' }, origin: 'local', size: 1, mtime: 0, addedAt: 1 }, 'menu-1')
        const kv = tx.objectStore('kv')
        const rev = kv.get('items.rev')
        rev.onsuccess = () => kv.put((rev.result ?? 0) + 1, 'items.rev')
        tx.oncomplete = res
        tx.onerror = () => rej(tx.error)
      }
    }))
    await ep.reload()
    await ep.locator('.toolbar .chip', { hasText: /^All/ }).click()
    await ep.locator('.vgrid .card', { hasText: 'Menu track' }).click({ button: 'right' })
    await ep.locator('.ctx').waitFor()
    await ep.keyboard.press('Escape')
    await ep.waitForTimeout(300)
    check(await ep.locator('.ctx').count() === 0 && ep.url().endsWith('#/library'), `Escape closes the Library card menu and stays in the Library (${ep.url().split('#')[1]})`)
    await ep.goto(`${BASE}/#/settings/plugins`)
    const addBtn = ep.locator('#plugins').getByRole('button', { name: 'Add' })
    const addSheet = ep.getByRole('dialog', { name: 'Add to Flick' })
    await addBtn.click()
    await addSheet.waitFor()
    await ep.keyboard.press('Escape')
    await ep.waitForTimeout(300)
    check(await addSheet.count() === 0 && ep.url().endsWith('#/settings/plugins'), `Escape closes the Add sheet and stays on the page (${ep.url().split('#')[1]})`)
    // Tab and Shift+Tab stay inside the sheet, past either end.
    const tabsOut = async (dialog) => {
      const n = await dialog.evaluate((d) => d.querySelectorAll('a[href], button, input, select, textarea').length)
      let out = 0
      for (let i = 0; i < n + 2; i++) { await ep.keyboard.press('Tab'); if (!(await dialog.evaluate((d) => d.contains(document.activeElement)))) out++ }
      for (let i = 0; i < 3; i++) { await ep.keyboard.press('Shift+Tab'); if (!(await dialog.evaluate((d) => d.contains(document.activeElement)))) out++ }
      return out
    }
    await addBtn.click()
    await addSheet.waitFor()
    const addOut = await tabsOut(addSheet)
    check(addOut === 0, `Tab stays inside the Add sheet (${addOut} presses left it)`)
    await addSheet.getByLabel('Plugin address').fill(`${FLICK_URL}/grid-plugin.js`)
    await addSheet.getByRole('button', { name: 'Add', exact: true }).click()
    const review = ep.getByRole('dialog', { name: /^Install / })
    await review.waitFor({ timeout: 15000 })
    const reviewOut = await tabsOut(review)
    check(reviewOut === 0, `Tab stays inside the install review (${reviewOut} presses left it)`)
    await ep.keyboard.press('Escape')
    await ep.waitForTimeout(300)
    check(await review.count() === 0 && await addSheet.count() === 1 && ep.url().endsWith('#/settings/plugins'), `Escape closes the install review and goes back to the Add sheet (${ep.url().split('#')[1]})`)
    await ep.keyboard.press('Escape')
    await addSheet.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    await ep.evaluate(() => document.activeElement?.blur())
    await ep.keyboard.press('Escape')
    await ep.waitForTimeout(400)
    check(ep.url().endsWith('#/library'), `Escape with nothing open goes back one page (${ep.url().split('#')[1]})`)
    await ep.context().close()
  }

  // Home and Library list the same things to continue: no item the library no longer has, and no show
  // whose newest episode is finished. Remove from library takes the item's place with it.
  const cp = await photoPage()
  await cp.goto(`${BASE}/#/library`)
  await cp.waitForTimeout(500)
  await cp.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('flick')
    r.onsuccess = () => {
      const tx = r.result.transaction(['items', 'progress', 'kv'], 'readwrite')
      const it = (id, title, more) => tx.objectStore('items').put({ id, title, src: { t: 'url', url: `http://127.0.0.1:9/${id}` }, origin: 'local', size: 1, mtime: 0, addedAt: 1, ...more }, id)
      it('kept-1', 'Kept track', { kind: 'audio' })
      it('ep-1', 'One', { kind: 'video', show: 'Finished Show', season: 1, episode: 1, poster: 'http://127.0.0.1:9/p.jpg' })
      it('ep-2', 'Two', { kind: 'video', show: 'Finished Show', season: 1, episode: 2, poster: 'http://127.0.0.1:9/p.jpg' })
      const pr = (id, title, pos, at) => tx.objectStore('progress').put({ pos, dur: 1000, at, title, ref: { t: 'item', id } }, id)
      pr('kept-1', 'Kept track', 100, 30)
      pr('gone-1', 'Removed film', 100, 40)
      pr('ep-1', 'Finished Show', 100, 10)
      pr('ep-2', 'Finished Show', 990, 20)
      const kv = tx.objectStore('kv')
      const rev = kv.get('items.rev')
      rev.onsuccess = () => kv.put((rev.result ?? 0) + 1, 'items.rev')
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    }
  }))
  const homeCont = async () => {
    await cp.goto(`${BASE}/#/`)
    await cp.locator('.page-head h1', { hasText: 'Home' }).waitFor({ timeout: 10000 })
    await cp.waitForTimeout(300)
    return cp.locator('.row-section', { has: cp.getByRole('heading', { name: 'Continue watching' }) }).locator('.card').evaluateAll((l) => l.map((c) => c.title))
  }
  await cp.reload()
  const homeList = await homeCont()
  await cp.goto(`${BASE}/#/library`)
  await cp.locator('.toolbar .chip', { hasText: /^Continue/ }).click()
  await cp.locator('.continue-grid .card').first().waitFor({ timeout: 10000 })
  const libList = await cp.locator('.continue-grid .card').evaluateAll((l) => l.map((c) => c.title))
  check(homeList.join() === 'Kept track' && libList.join() === 'Kept track', `Home and Library continue the same, without a removed item or a finished show (Home: ${homeList.join(', ')}; Library: ${libList.join(', ')})`)
  await cp.locator('.toolbar .chip', { hasText: /^All/ }).click()
  await cp.locator('.vgrid .card', { hasText: 'Kept track' }).click({ button: 'right' })
  await cp.locator('.ctx').getByRole('button', { name: 'Remove from library' }).click()
  await cp.locator('.vgrid .card', { hasText: 'Kept track' }).waitFor({ state: 'detached', timeout: 5000 })
  const keptPlace = await cp.evaluate(() => new Promise((res) => { const r = indexedDB.open('flick'); r.onsuccess = () => { const q = r.result.transaction('progress').objectStore('progress').get('kept-1'); q.onsuccess = () => res(q.result ?? null) } }))
  const afterHome = await homeCont()
  check(keptPlace === null && afterHome.length === 0, `Remove from library clears the item's place, and Home has nothing to continue (${afterHome.join(', ') || 'none'})`)

  // Library keeps its search and sort for the session: after Back, and after a reload.
  await cp.goto(`${BASE}/#/library`)
  await cp.getByLabel('Search library').fill('Tw')
  await cp.getByLabel('Sort').selectOption('title')
  await cp.goto(`${BASE}/#/settings`)
  await cp.goBack()
  const libState = async () => [await cp.getByLabel('Search library').inputValue(), await cp.getByLabel('Sort').inputValue()].join()
  await cp.getByLabel('Sort').waitFor()
  const afterBack = await libState()
  await cp.reload()
  await cp.getByLabel('Sort').waitFor()
  const afterReload = await libState()
  check(afterBack === 'Tw,title' && afterReload === 'Tw,title', `Library keeps its search and sort after Back and a reload (${afterBack}; ${afterReload})`)

  // Default speed lists the player's speeds, and a saved speed is never shown blank.
  const speedShown = async (speed) => {
    await cp.evaluate((v) => localStorage.setItem('flick.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('flick.settings') || '{}'), speed: v })), speed)
    await cp.goto(`${BASE}/#/settings`)
    await cp.reload()
    return cp.getByLabel('Default speed').evaluate((s) => s.selectedOptions[0]?.textContent ?? '')
  }
  const shown = [await speedShown(2.5), await speedShown(1.2)]
  check(shown.join() === '2.5×,1.2×', `Default speed shows a speed set in the player and one off its list (${shown.join(', ') || 'blank'})`)
  await cp.context().close()

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await browser.close()
} finally {
  server?.kill()
  flick.close()
  nas.close()
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1) }
console.log('\nsmoke: all checks passed')
