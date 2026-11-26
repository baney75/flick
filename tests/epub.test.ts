import { describe, expect, it } from 'vitest'
import { unzip, resolvePath, toPos, fromPos } from '../src/lib/epub'
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
