import { describe, it, expect } from 'vitest'
import { parseSearch } from '../src/lib/youtube'
import fixture from './fixtures/yt-search.json'

describe('youtube search parsing', () => {
  it('maps yt-dlp flat search entries to results', () => {
    const r = parseSearch(fixture)
    expect(r.map((x) => x.id)).toEqual(['jNQXAC9IVRw', 'zEVYvCKQ1gM', 'abcdefghijk'])
    expect(r[0]).toMatchObject({ title: 'Me at the zoo', channel: 'jawed', duration: 19 })
    expect(r[0].thumbnail).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/jNQXAC9IVRw\//)
  })

  it('picks the widest thumbnail', () => {
    expect(parseSearch(fixture)[1].thumbnail).toContain('CNAFEJQD')
  })

  it('skips channels, falls back to the uploader and a default thumbnail', () => {
    const last = parseSearch(fixture)[2]
    expect(last).toEqual({ id: 'abcdefghijk', title: 'No channel, no thumbnails', channel: 'Someone', duration: 0, thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' })
  })

  it('handles empty or missing output', () => {
    expect(parseSearch(null)).toEqual([])
    expect(parseSearch({})).toEqual([])
  })
})
