import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain JS plugin with no types of its own
import { parts } from '../plugins/archive/plugin.js'

const f = (name: string, format: string, more: Record<string, string> = {}) => ({ name, format, source: 'original', ...more })
const keys = (list: { key: string }[]) => list.map((g) => g.key)

describe('Internet Archive plugin parts', () => {
  it('joins a derivative to its original and prefers h.264', () => {
    const p = parts('show', [
      f('S01E02.mp4', 'MPEG4', { original: 'show.torrent' }),
      f('S01E02.ia.mp4', 'h.264 IA', { source: 'derivative', original: 'S01E02.mp4' }),
      f('S01E01.avi', 'AVI'),
      f('S01E01.mp4', 'h.264', { source: 'derivative', original: 'S01E01.avi' }),
    ])
    expect(keys(p)).toEqual(['S01E01.avi', 'S01E02.mp4'])
    expect(p[1].files.map((x: { name: string }) => x.name)).toEqual(['S01E02.ia.mp4', 'S01E02.mp4'])
    expect(p[0].files[0].name).toBe('S01E01.mp4')
  })
  it('keeps only the main kind: no MP3 in a film, no PDF in an audiobook', () => {
    expect(parts('film', [f('film.mp4', 'h.264'), f('film.mp3', 'VBR MP3', { source: 'derivative', original: 'film.mp4' })])[0].files).toHaveLength(1)
    expect(keys(parts('book_librivox', [f('a.pdf', 'Text PDF'), f('ch1.mp3', 'VBR MP3', { track: '1' })]))).toEqual(['ch1.mp3'])
  })
  it('orders by track only when every part has one', () => {
    expect(keys(parts('otr', [f('ep003.mp3', 'MP3'), f('ep010.mp3', 'MP3', { track: '11' }), f('ep002.mp3', 'MP3')]))).toEqual(['ep002.mp3', 'ep003.mp3', 'ep010.mp3'])
    expect(keys(parts('lv', [f('b.mp3', 'MP3', { track: '1' }), f('a.mp3', 'MP3', { track: '2' })]))).toEqual(['b.mp3', 'a.mp3'])
  })
  it('makes a book one part with the PDF first', () => {
    const p = parts('bk', [f('bk.epub', 'EPUB', { source: 'derivative', original: 'bk_abbyy.gz' }), f('bk.pdf', 'Text PDF', { source: 'derivative', original: 'bk.json' })])
    expect(keys(p)).toEqual(['bk'])
    expect(p[0].files.map((x: { format: string }) => x.format)).toEqual(['Text PDF', 'EPUB'])
  })
})
