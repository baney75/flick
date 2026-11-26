import { describe, expect, it } from 'vitest'
import { unzip, resolvePath, toPos, fromPos, coverBlob, type Book } from '../src/lib/epub'
import { zip } from '../scripts/epub-fixture.mjs'

const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

describe('epub', () => {
  it('reads stored and deflated zip entries', async () => {
    const z = unzip(ab(zip([['mimetype', 'application/epub+zip', true], ['OEBPS/a b.xhtml', 'hello '.repeat(500)]])))
    expect([...z.keys()]).toEqual(['mimetype', 'OEBPS/a b.xhtml'])
    expect(new TextDecoder().decode(await z.get('mimetype')!())).toBe('application/epub+zip')
    expect(new TextDecoder().decode(await z.get('OEBPS/a b.xhtml')!())).toBe('hello '.repeat(500))
  })

  it('refuses a file that is not a zip', () => {
    expect(() => unzip(new TextEncoder().encode('%PDF-1.4 not a zip at all').buffer as ArrayBuffer)).toThrow(/not a valid EPUB/)
  })

  it('resolves paths inside the book', () => {
    expect(resolvePath('OEBPS/content.opf', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml')
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.png')).toBe('OEBPS/images/a b.png')
    expect(resolvePath('OEBPS/text/ch1.xhtml', 'ch2.xhtml#sec')).toBe('OEBPS/text/ch2.xhtml')
    expect(resolvePath('a.xhtml', '../../../etc/passwd')).toBe('etc/passwd')
  })

  it('keeps the place as one number that Continue and sync understand', () => {
    expect(toPos(0, 0, 10)).toBe(1)
    expect(toPos(2, 5, 10)).toBe(3.5)
    expect(fromPos(3.5, 4)).toEqual({ chapter: 2, frac: 0.5 })
    expect(fromPos(undefined, 4)).toEqual({ chapter: 0, frac: 0 })
    // The end of the book (pos = chapters + 1) opens on the last page of the last chapter.
    expect(fromPos(5, 4)).toEqual({ chapter: 3, frac: 1 })
  })
})

describe('epub covers', () => {
  const book = (bytes: Uint8Array, declared: string) =>
    ({ spine: [], toc: [], cover: 'c', types: new Map([['c', declared]]), zip: new Map([['c', async () => bytes]]) }) as unknown as Book
  const enc = (t: string) => new TextEncoder().encode(t)
  it('refuses a cover that is not a raster image, whatever the book declares', async () => {
    expect(await coverBlob(book(enc('<html><script>alert(1)</script></html>'), 'image/png'))).toBe(null)
    expect(await coverBlob(book(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'))).toBe(null)
  })
  it('types a real image by its bytes, not the manifest', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect((await coverBlob(book(png, 'text/html')))?.type).toBe('image/png')
    expect((await coverBlob(book(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'text/html')))?.type).toBe('image/jpeg')
  })
})
