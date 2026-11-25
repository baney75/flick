import { describe, it, expect } from 'vitest'
import { parseName, kindOf, formatTime } from '../src/lib/parse'

describe('parseName', () => {
  it('reads a TV episode with an episode title', () => {
    expect(parseName('The.Office.US.S02E05.Halloween.1080p.WEB-DL.x264.mkv')).toEqual({ show: 'The Office US', season: 2, episode: 5, title: 'Halloween' })
  })
  it('reads 1x02 style episodes and falls back to Episode N', () => {
    expect(parseName('firefly 1x02 720p.mp4')).toMatchObject({ show: 'Firefly', season: 1, episode: 2, title: 'Episode 2' })
  })
  it('strips a release group and year from show names', () => {
    expect(parseName('[Group] Doctor Who 2005 S01E01 Rose.mkv')).toMatchObject({ show: 'Doctor Who', season: 1, episode: 1, title: 'Rose' })
  })
  it('reads a movie with a year', () => {
    expect(parseName('Blade.Runner.2049.2017.2160p.UHD.BluRay.mkv')).toEqual({ title: 'Blade Runner 2049', year: 2017 })
    expect(parseName('The Matrix (1999).mp4')).toEqual({ title: 'The Matrix', year: 1999 })
  })
  it('cleans a movie without a year', () => {
    expect(parseName('some_home_video.mov').title).toBe('Some Home Video')
    expect(parseName('Interstellar 1080p BluRay.mkv').title).toBe('Interstellar')
  })
})

describe('kindOf and formatTime', () => {
  it('knows media types', () => {
    expect(kindOf('a.MKV')).toBe('video')
    expect(kindOf('b.flac')).toBe('audio')
    expect(kindOf('c.txt')).toBeNull()
  })
  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(NaN)).toBe('0:00')
  })
})
