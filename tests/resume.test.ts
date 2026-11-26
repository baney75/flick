import { describe, it, expect } from 'vitest'
import { resumeOf, progressKey } from '../src/lib/plugins/resume'

const at = (videoId: string, pos: number, dur: number, t: number) => ({ [progressKey('p', videoId)]: { pos, dur, at: t } })
const eps = [
  { id: 's1e2', season: 1, episode: 2 },
  { id: 's1e1', season: 1, episode: 1 },
  { id: 'sp1', season: 0, episode: 1 },
  { id: 's2e1', season: 2, episode: 1 },
]

describe('resume a plugin title', () => {
  const cases: [string, Record<string, { pos: number; dur: number; at: number }>, ReturnType<typeof resumeOf>, typeof eps | undefined][] = [
    ['nothing watched', {}, null, undefined],
    ['a film half watched', at('film', 600, 6000, 1), { videoId: 'film', pos: 600, next: false }, undefined],
    ['a film barely started', at('film', 4, 6000, 1), null, undefined],
    ['a film finished', at('film', 5900, 6000, 1), null, undefined],
    ['a film with no duration yet', at('film', 600, 0, 1), null, undefined],
    ['another plugin\'s progress', { 'pl:q:film': { pos: 600, dur: 6000, at: 1 } }, null, undefined],
    ['the episode watched last wins', { ...at('s1e1', 300, 1200, 5), ...at('s2e1', 100, 1200, 2) }, { videoId: 's1e1', pos: 300, next: false }, eps],
    ['a finished episode offers the next one', at('s1e1', 1190, 1200, 1), { videoId: 's1e2', pos: 0, next: true }, eps],
    ['the season finale leads to the next season, not specials', at('s1e2', 1190, 1200, 1), { videoId: 's2e1', pos: 0, next: true }, eps],
    ['the last episode has nothing next', at('sp1', 1190, 1200, 1), null, eps],
    ['an episode barely started offers nothing', at('s1e1', 3, 1200, 1), null, eps],
  ]
  it.each(cases)('%s', (_name, saved, want, videos) => {
    expect(resumeOf(saved, 'p', 'film', videos)).toEqual(want)
  })
})
