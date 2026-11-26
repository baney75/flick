// EPUB books: a small zip reader, the package (spine, contents, cover), and chapters made safe to show.
// Book files are untrusted. A chapter becomes an HTML page with every script, handler, form, frame and
// outside link removed, and resources inlined as data URLs. The reader shows it in an iframe sandboxed
// without allow-same-origin, under a CSP that runs only Flick's own pager script (by nonce) and loads nothing
// from the network. Even a script that slipped through would run in an opaque origin with no access to Flick.

export type Zip = Map<string, () => Promise<Uint8Array>>

/** Reads a zip's directory. Entries inflate on demand with the browser's own deflate. */
export function unzip(buf: ArrayBuffer): Zip {
  const v = new DataView(buf)
  let e = buf.byteLength - 22
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--
  if (e < 0) throw new Error('This book is not a valid EPUB file.')
  const out: Zip = new Map()
  let p = v.getUint32(e + 16, true)
  for (let n = v.getUint16(e + 10, true); n > 0 && v.getUint32(p, true) === 0x02014b50; n--) {
    const method = v.getUint16(p + 10, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen))
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    out.set(name, async () => {
      const at = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
      const raw = new Uint8Array(buf, at, size)
      if (method === 0) return raw
      if (method !== 8) throw new Error(`Unsupported zip method ${method}`)
      return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
    })
  }
  return out
}

/** A path inside the book, relative to the file `base` it appears in. Drops any #fragment. */
export function resolvePath(base: string, href: string): string {
  try { return decodeURIComponent(new URL(href, `http://x/${base}`).pathname.slice(1)) } catch { return '' }
}

export interface Toc { label: string; path: string; frag: string; depth: number }
export interface Book { title?: string; author?: string; spine: string[]; toc: Toc[]; cover?: string; types: Map<string, string>; zip: Zip }

const text = async (zip: Zip, path: string) => {
  const get = zip.get(path)
  if (!get) throw new Error(`This book is missing ${path}.`)
  return new TextDecoder().decode(await get())
}
const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
const tags = (d: Document | Element, name: string) => [...d.getElementsByTagNameNS('*', name)]

export async function openEpub(buf: ArrayBuffer): Promise<Book> {
  const zip = unzip(buf)
  const opfPath = tags(xml(await text(zip, 'META-INF/container.xml')), 'rootfile')[0]?.getAttribute('full-path') ?? ''
  const opf = xml(await text(zip, opfPath))
  const items = new Map(tags(opf, 'item').map((i) => [i.getAttribute('id') ?? '', i]))
  const pathOf = (i?: Element) => (i ? resolvePath(opfPath, i.getAttribute('href') ?? '') : '')
  const types = new Map([...items.values()].map((i) => [pathOf(i), i.getAttribute('media-type') ?? '']))
  const spine = tags(opf, 'itemref').map((r) => pathOf(items.get(r.getAttribute('idref') ?? ''))).filter((p) => zip.has(p))
  if (!spine.length) throw new Error('This EPUB has no chapters.')
  const coverId = tags(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content')
  const coverItem = [...items.values()].find((i) => /\bcover-image\b/.test(i.getAttribute('properties') ?? '')) ?? items.get(coverId ?? '')
  const toc: Toc[] = []
  const entry = (label: string, base: string, href: string, depth: number) => {
    if (label && href) toc.push({ label: label.replace(/\s+/g, ' ').trim(), path: resolvePath(base, href), frag: href.split('#')[1] ?? '', depth })
  }
  const nav = [...items.values()].find((i) => /\bnav\b/.test(i.getAttribute('properties') ?? ''))
  const ncx = items.get(tags(opf, 'spine')[0]?.getAttribute('toc') ?? '')
  if (nav && zip.has(pathOf(nav))) {
    const d = xml(await text(zip, pathOf(nav)))
    const list = tags(d, 'nav').find((n) => (n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? n.getAttribute('epub:type')) === 'toc') ?? tags(d, 'nav')[0]
    for (const a of list ? tags(list, 'a') : []) {
      let depth = 0
      for (let p = a.parentElement; p && p !== list; p = p.parentElement) if (p.localName === 'ol') depth++
      entry(a.textContent ?? '', pathOf(nav), a.getAttribute('href') ?? '', depth - 1)
    }
  } else if (ncx && zip.has(pathOf(ncx))) {
    const walk = (el: Element, depth: number) => {
      for (const np of [...el.children].filter((c) => c.localName === 'navPoint')) {
        entry(tags(np, 'text')[0]?.textContent ?? '', pathOf(ncx), tags(np, 'content')[0]?.getAttribute('src') ?? '', depth)
        walk(np, depth + 1)
      }
    }
    const map = tags(xml(await text(zip, pathOf(ncx))), 'navMap')[0]
    if (map) walk(map, 0)
  }
  const meta = (n: string) => tags(opf, n)[0]?.textContent?.trim() || undefined
  return { title: meta('title'), author: meta('creator'), spine, toc, cover: coverItem ? pathOf(coverItem) : undefined, types, zip }
}

export async function coverBlob(b: Book): Promise<Blob | null> {
  const get = b.cover ? b.zip.get(b.cover) : undefined
  return get ? new Blob([(await get()) as BlobPart], { type: b.types.get(b.cover!) || 'image/jpeg' }) : null
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' }

async function dataUrl(b: Book, path: string): Promise<string> {
  const get = b.zip.get(path)
  if (!get) return ''
  const bytes = await get()
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${b.types.get(path) || MIME[path.split('.').pop()!.toLowerCase()] || 'application/octet-stream'};base64,${btoa(bin)}`
}

/** CSS with @import dropped and every url() inlined from the book, or emptied. */
async function safeCss(b: Book, css: string, base: string): Promise<string> {
  css = css.replace(/@import[^;]*;?/gi, '')
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)]
  const data = await Promise.all(urls.map((m) => (m[2].startsWith('#') || m[2].includes(':') ? '' : dataUrl(b, resolvePath(base, m[2])))))
  let i = 0
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, () => `url("${data[i++]}")`)
}

// Only these elements survive, compared by lowercased local name so XHTML case tricks don't slip by.
// Anything else is unwrapped (its text kept, escaped) unless it is in GONE, which goes with its content.
// No raw-text element (style, script, xmp, noembed, noframes, plaintext, noscript, iframe) is ever
// kept, so nothing in the book's text can become markup when the page is written out and read back.
const KEEP = new Set(('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr ' +
  'svg g path rect circle ellipse line polyline polygon text tspan textpath image use defs symbol lineargradient radialgradient stop clippath mask pattern marker desc ' +
  'math mi mo mn ms mtext mrow msup msub msubsup mfrac msqrt mroot mspace mtable mtr mtd mstyle mover munder munderover mpadded mphantom menclose semantics').split(' '))
const GONE = new Set('script style iframe frame frameset object embed applet base meta link form noscript template title portal audio video animate set xmp noembed noframes plaintext textarea select button input head foreignobject annotation-xml'.split(' '))

function clean(node: Node) {
  for (const n of [...node.childNodes]) {
    if (n.nodeType === Node.TEXT_NODE) continue
    if (n.nodeType === Node.CDATA_SECTION_NODE) { n.replaceWith(n.ownerDocument!.createTextNode(n.textContent ?? '')); continue }
    if (n.nodeType !== Node.ELEMENT_NODE) { n.remove(); continue }
    const name = (n as Element).localName.toLowerCase()
    if (KEEP.has(name)) clean(n)
    else if (GONE.has(name)) n.remove()
    else { clean(n); (n as Element).replaceWith(...n.childNodes) }
  }
}
const LINKS = ['href', 'xlink:href']
const RES = ['src', 'poster', 'data']

export interface PageOpts { start: number | 'end' | string; size: number; night: boolean; gen: number }

/** One chapter as a self-contained, script-free HTML page plus Flick's pager. */
export async function chapterPage(b: Book, index: number, o: PageOpts): Promise<string> {
  const path = b.spine[index]
  const src = await text(b.zip, path)
  let d = new DOMParser().parseFromString(src, 'application/xhtml+xml')
  if (d.getElementsByTagName('parsererror').length || !d.body) d = new DOMParser().parseFromString(src, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const sheets = await Promise.all([...d.querySelectorAll('style, link')].map(async (s) => {
    if (s.localName.toLowerCase() === 'style') return safeCss(b, s.textContent ?? '', path)
    const href = s.getAttribute('href') ?? ''
    if (!/\bstylesheet\b/i.test(s.getAttribute('rel') ?? '') || href.includes(':')) return ''
    const p = resolvePath(path, href)
    return b.zip.has(p) ? safeCss(b, await text(b.zip, p), p) : ''
  }))
  for (const k of ['class', 'id', 'lang', 'dir']) { const v = d.body?.getAttribute(k); if (v) out.body.setAttribute(k, v) }
  out.body.append(...[...(d.body?.childNodes ?? [])].map((n) => out.importNode(n, true)))
  clean(out.body)
  const jobs: Promise<void>[] = []
  for (const el of out.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase()
      if (n === 'style') { const v = a.value; el.removeAttribute(a.name); jobs.push(safeCss(b, v, path).then((c) => el.setAttribute('style', c))) }
      else if (LINKS.includes(n) && el.localName.toLowerCase() === 'a') {
        el.removeAttribute(a.name)
        if (!a.value.includes(':')) el.setAttribute('data-href', a.value.startsWith('#') ? `${path}${a.value}` : `${resolvePath(path, a.value)}#${a.value.split('#')[1] ?? ''}`)
      } else if (LINKS.includes(n) || RES.includes(n)) {
        el.removeAttribute(a.name)
        if (a.value.startsWith('#') && el.localName.toLowerCase() === 'use') el.setAttribute('href', a.value)
        else if (!a.value.includes(':')) jobs.push(dataUrl(b, resolvePath(path, a.value)).then((u) => { if (u) el.setAttribute(n === 'xlink:href' ? 'href' : n, u) }))
      } else if (n.startsWith('on') || n === 'srcset' || n.endsWith('action') || n === 'ping' || n === 'target') el.removeAttribute(a.name)
    }
  }
  await Promise.all(jobs)
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
  const csp = `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    sheets.map((s) => `<style>${s.replace(/</g, '\\3c ')}</style>`).join('') + `<style>${readerCss(o)}</style>`
  const body = out.body.outerHTML.replace(/<\/body>$/, `<script nonce="${nonce}">(${pager})(${JSON.stringify(o.start)}, ${o.gen | 0})</script></body>`)
  return `<!doctype html><html><head>${head}</head>${body}</html>`
}

const GAP = 24
function readerCss(o: PageOpts) {
  return `html{height:100vh;overflow:hidden;font-size:${o.size}%;background:${o.night ? '#121212' : '#fbfaf7'};color:${o.night ? '#d6d6d6' : '#1b1b1b'}}
body{margin:0!important;box-sizing:border-box;height:100vh;width:100vw;max-width:none!important;padding:40px ${GAP}px!important;line-height:1.55;
column-width:calc(100vw - ${2 * GAP}px);column-gap:${2 * GAP}px;column-fill:auto;overflow-wrap:break-word}
img,svg,video,table{max-width:100%;max-height:calc(100vh - 80px);object-fit:contain;break-inside:avoid}
${o.night ? 'body *{color:inherit!important;background-color:transparent!important}a{color:#8ab4f8!important}' : ''}`
}

/** Runs inside the sandboxed chapter: lays out pages, turns them, and reports where the reader is. */
function pager(start: number | 'end' | string, gen: number) {
  const se = document.scrollingElement as HTMLElement
  const say = (m: object) => parent.postMessage({ ...m, g: gen }, '*')
  let page = 0
  let pages = 1
  const count = () => { pages = Math.max(1, Math.round(se.scrollWidth / innerWidth)) }
  const show = () => { se.scrollLeft = page * innerWidth; say({ t: 'pos', page, pages }) }
  const go = (d: number) => {
    count()
    if (page + d < 0 || page + d >= pages) return say({ t: 'edge', d })
    page += d
    show()
  }
  addEventListener('load', () => requestAnimationFrame(() => {
    count()
    const el = typeof start === 'string' && start !== 'end' ? document.getElementById(start) : null
    page = start === 'end' ? pages - 1 : el ? Math.floor((el.getBoundingClientRect().left + se.scrollLeft) / innerWidth) : typeof start === 'number' ? Math.round(start * pages) : 0
    page = Math.min(Math.max(0, page), pages - 1)
    show()
  }))
  addEventListener('resize', () => { const f = page / pages; count(); page = Math.min(pages - 1, Math.round(f * pages)); show() })
  addEventListener('message', (e) => { if (e.source === parent && e.data?.t === 'turn') go(e.data.d) })
  addEventListener('keydown', (e) => {
    say({ t: 'key', key: e.key, shift: e.shiftKey })
    if ([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) e.preventDefault()
  })
  addEventListener('click', (e) => {
    e.preventDefault()
    const a = (e.target as Element).closest?.('[data-href]')
    if (a) return say({ t: 'link', href: a.getAttribute('data-href') })
    go(e.clientX < innerWidth / 3 ? -1 : 1)
  })
  let x0: number | null = null
  addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX }, { passive: true })
  addEventListener('touchend', (e) => {
    const dx = x0 == null ? 0 : e.changedTouches[0].clientX - x0
    x0 = null
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
  })
}

/** Reading position as one number: 1 + chapter index + fraction through it. A book's length is chapters + 1. */
export const toPos = (chapter: number, page: number, pages: number) => 1 + chapter + Math.round((page / Math.max(1, pages)) * 1e4) / 1e4
export function fromPos(pos: number | undefined, chapters: number): { chapter: number; frac: number } {
  const p = Math.max(0, (pos ?? 1) - 1)
  const chapter = Math.min(chapters - 1, Math.floor(p))
  return { chapter, frac: chapter === Math.floor(p) ? p - chapter : 1 }
}
