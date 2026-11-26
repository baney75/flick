// Builds small EPUB files for tests and the smoke run, so no book binaries live in the repo.
import { deflateRawSync, crc32 } from 'node:zlib'

/** A zip of [name, body, store?] entries. Stored entries skip compression, as mimetype must. */
export function zip(files) {
  const parts = []
  const dir = []
  let off = 0
  for (const [name, body, store] of files) {
    const data = Buffer.from(body)
    const comp = store ? data : deflateRawSync(data)
    const n = Buffer.from(name)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(store ? 0 : 8, 8)
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(store ? 0 : 8, 10)
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42)
    parts.push(h, n, comp)
    dir.push(c, n)
    off += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(dir)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, end])
}

// Everything a hostile book might try. None of it may run.
export const EVIL = `<script>parent.postMessage({pwned:'script'},'*');try{localStorage.setItem('pwned','1')}catch(e){}</script>
<img src="missing.png" onerror="parent.postMessage({pwned:'onerror'},'*')" alt=""/>
<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>parent.postMessage({pwned:'svg'},'*')</script></svg>
<iframe src="data:text/html,&lt;script&gt;parent.parent.postMessage({pwned:'iframe'},'*')&lt;/script&gt;"></iframe>
<p><a id="evil" href="javascript:parent.postMessage({pwned:'link'},'*')">A link that runs a script</a></p>
<META http-equiv="refresh" content="0;url=http://127.0.0.1:9/upper-meta"/><SCRIPT>parent.postMessage({pwned:'upper-script'},'*')</SCRIPT>
<xmp>&lt;/xmp&gt;&lt;meta http-equiv="refresh" content="0;url=http://127.0.0.1:9/xmp"&gt;</xmp>
<noembed>&lt;/noembed&gt;&lt;meta http-equiv="refresh" content="0;url=http://127.0.0.1:9/noembed"&gt;</noembed>`

const para = (i) => `<p>Paragraph ${i}. ${'The quick brown fox jumps over the lazy dog while the reader turns another page. '.repeat(6)}</p>`

/** An EPUB 3 book (nav contents) or, with ncx, an EPUB 2 book (NCX contents). Chapters are [title, extra html]. */
export function makeEpub({ title, author, chapters, cover, ncx = false }) {
  const xhtml = (t, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title><link rel="stylesheet" href="../style.css"/></head><body><h1 id="top">${t}</h1>${body}</body></html>`
  const ch = chapters.map(([t, extra = ''], i) => [`OEBPS/text/ch${i + 1}.xhtml`, xhtml(t, extra + Array.from({ length: 30 }, (_, j) => para(j + 1)).join('') + `<p id="end-${i + 1}">End of ${t}.</p>`)])
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="text/ch${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`
  const toc = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${chapters.map(([t], i) => `<navPoint id="n${i}"><navLabel><text>${t}</text></navLabel><content src="text/ch${i + 1}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="${ncx ? '2.0' : '3.0'}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>${cover ? '<meta name="cover" content="cover"/>' : ''}</metadata><manifest>
${ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
${cover ? '<item id="cover" href="images/cover.png" media-type="image/png"/>' : ''}<item id="css" href="style.css" media-type="text/css"/>
${chapters.map((_, i) => `<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>
<spine${ncx ? ' toc="ncx"' : ''}>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`
  return zip([
    ['mimetype', 'application/epub+zip', true],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', opf],
    ncx ? ['OEBPS/toc.ncx', toc] : ['OEBPS/nav.xhtml', nav],
    ['OEBPS/style.css', '@import url("https://example.com/track.css"); h1 { text-align: center; } body { background: url("https://example.com/pixel.png"); } p::after { content: "</sty</stylele><meta http-equiv=refresh content=0;url=http://127.0.0.1:9/css>"; }'],
    ...(cover ? [['OEBPS/images/cover.png', cover, true]] : []),
    ...ch,
  ])
}
