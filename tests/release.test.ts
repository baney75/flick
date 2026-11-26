import { describe, expect, it } from 'vitest'
import { bytesOf, codecOf, langCode, parseRelease } from '../src/lib/release'

describe('release audio languages', () => {
  it.each([
    ['Movie 1080p 🇫🇷', ['fr']],
    ['Movie 720p 🇬🇧', ['en']],
    ['Movie 🇺🇸 / 🇲🇽', ['en', 'es']],
    ['🇧🇷 🇯🇵 🇰🇷 🇹🇼 🇷🇺 🇮🇳 🇩🇪 🇮🇹', ['pt', 'ja', 'ko', 'zh', 'ru', 'hi', 'de', 'it']],
    ['Movie.2020.1080p.Latino.WEB-DL', ['es']],
    ['Movie 1080p ENG', ['en']],
    ['Movie.TRUEFRENCH.1080p', ['fr']],
    ['Movie VFF 1080p', ['fr']],
    ['Movie_ITA_720p', ['it']],
    ['Movie GER DL', ['de']],
    ['Movie RUS 720p', ['ru']],
    ['Movie Japanese Korean Hindi Portuguese', ['ja', 'ko', 'hi', 'pt']],
    ['Movie 1080p MULTI', ['multi']],
    ['Movie Dual Audio 1080p', ['multi']],
    ['Movie 1080p', []],
    ['Greta Gerwig film', []],
  ])('%s reads %j', (text, audio) => expect(parseRelease(text).audio.sort()).toEqual([...audio].sort()))

  it('reads VOSTFR as French subtitles, not French audio', () => {
    const r = parseRelease('Movie 1080p VOSTFR')
    expect(r.audio).toEqual([])
    expect(r.subs).toEqual(['fr'])
    expect(parseRelease('Movie SUBFRENCH 720p')).toMatchObject({ audio: [], subs: ['fr'] })
  })

  it('normalizes language tags', () => {
    expect(['en-US', 'en-GB', 'eng', 'English', 'fra', 'pt_BR', 'und', '', 'xyz'].map(langCode))
      .toEqual(['en', 'en', 'en', 'en', 'fr', 'pt', null, null, null])
  })
})

describe('release details', () => {
  it.each([
    ['Movie 1080p x265', 'hevc'], ['Movie HEVC', 'hevc'], ['Movie H.265', 'hevc'], ['Movie H265 10bit', 'hevc'],
    ['Movie AV1', 'av1'], ['Movie x264', 'h264'], ['Movie H.264', 'h264'], ['Movie AVC', 'h264'], ['Movie 1080p', null],
  ])('%s codec %s', (text, codec) => expect(codecOf(text)).toBe(codec))

  it.each([
    ['Movie 1080p HDCAM', true], ['Movie CAM 720p', true], ['Movie.TS.XviD', true], ['Movie HDTS', true],
    ['Movie TELESYNC', true], ['Movie TC', true], ['Movie Telecine', true], ['Movie SCR', true],
    ['Movie Screener', true], ['Movie 720p WEB-DL', false], ['Cam 2018 1080p WEB', false], ['clip.ts', false], ['Scream 1996', false],
  ])('%s bad source %s', (text, bad) => expect(parseRelease(text).bad).toBe(bad))

  it('reads seeders', () => {
    expect(parseRelease('Movie 👤 40 💾 2 GB').seeders).toBe(40)
    expect(parseRelease('Movie Seeders: 12').seeders).toBe(12)
    expect(parseRelease('Movie S: 3 L: 1').seeders).toBe(3)
    expect(parseRelease('Movie 1080p').seeders).toBeUndefined()
  })

  it('reads size in bytes', () => {
    expect(bytesOf('💾 4.0 GB')).toBe(4e9)
    expect(bytesOf('700MB')).toBe(7e8)
    expect(bytesOf('1,5 GiB')).toBe(1.5 * 2 ** 30)
    expect(bytesOf('1080p')).toBeUndefined()
  })

  it('reads HDR and Dolby Vision apart', () => {
    expect(parseRelease('4K HDR')).toMatchObject({ hdr: true, dv: false })
    expect(parseRelease('4K DV')).toMatchObject({ hdr: false, dv: true })
    expect(parseRelease('4K DV HDR10')).toMatchObject({ hdr: true, dv: true })
    expect(parseRelease('4K')).toMatchObject({ hdr: false, dv: false })
  })

  it('reads audiobook abridgement and bitrate', () => {
    expect(parseRelease('Book Unabridged 128 kbps')).toMatchObject({ abridged: false, kbps: 128 })
    expect(parseRelease('Book (Abridged) 64kbps')).toMatchObject({ abridged: true, kbps: 64 })
    expect(parseRelease('Book').abridged).toBeUndefined()
  })
})
