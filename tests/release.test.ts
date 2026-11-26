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
    ['Movie.2020.1080p.DUAL.5.1', ['multi']],
    ['Movie.2020.1080p.CHINESE.WEB-DL', ['zh']],
    ['Movie 2020 VFQ 1080p', ['fr']],
    ['Movie 2020 Castellano', ['es']],
    ['The.Italian.Job.2003.1080p.BluRay.x264', []],
    ['The.French.Dispatch.2021.2160p.WEB-DL', []],
    ['Russian.Doll.S01E01.1080p', []],
    ['The.Italian.Job.2003.1080p.ITA.ENG', ['it', 'en']],
    ['Movie.2020.1080p\n👤 5 💾 2 GB\nMulti Audio / 🇫🇷', ['multi', 'fr']],
  ])('%s reads %j', (text, audio) => expect(parseRelease(text).audio.sort()).toEqual([...audio].sort()))

  it('reads VOSTFR as French subtitles, not French audio', () => {
    const r = parseRelease('Movie 1080p VOSTFR')
    expect(r.audio).toEqual([])
    expect(r.subs).toEqual(['fr'])
    expect(parseRelease('Movie SUBFRENCH 720p')).toMatchObject({ audio: [], subs: ['fr'] })
  })

  it.each([
    ['Movie.KOREAN.1080p.ENG.SUB', ['ko'], ['en']],
    ['Anime.S01.1080p.MULTi-SUBS', [], []],
    ['Movie 2020 English Subtitles', [], ['en']],
    ['Movie 2020 ITA SUB ENG', ['it'], ['en']],
    ['Movie 2020 JAP Subs: English', ['ja'], ['en']],
  ])('%s: audio %j, subtitles %j', (text, audio, subs) =>
    expect(parseRelease(text)).toMatchObject({ audio, subs }))

  it('normalizes language tags', () => {
    expect(['en-US', 'en-GB', 'eng', 'English', 'fra', 'pt_BR', 'und', '', 'xyz', 'English (SDH)', 'eng.forced', 'iw', 'in'].map(langCode))
      .toEqual(['en', 'en', 'en', 'en', 'fr', 'pt', null, null, null, 'en', 'en', 'he', 'id'])
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
    ['Movie Screener', true], ['Movie.2024.CAMRip.x264', true], ['Movie.2024.HDCAMRip', true],
    ['Movie.2024.DVDSCR', true], ['Movie.HDTC.720p', true], ['Movie.TSRip', true], ['Movie.PreDVDRip', true], ['Movie 720p WEB-DL', false], ['Cam 2018 1080p WEB', false], ['clip.ts', false], ['Scream 1996', false],
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
    expect(bytesOf('1,234 MB')).toBe(1.234e9)
    expect(bytesOf('1,024.5 MB')).toBe(1.0245e9)
    expect(bytesOf('💾 1.2 TB')).toBe(1.2e12)
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
