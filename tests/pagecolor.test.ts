import { describe, it, expect, beforeEach } from 'vitest'
import { savedColor, saveColor, chapterLeft } from '../src/lib/pagecolor'

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }

describe('reader page color', () => {
  beforeEach(() => store.clear())
  it('keeps Night for readers who turned it on before Paper existed', () => {
    store.set('flick.reader.night', '1')
    expect(savedColor()).toBe('night')
  })
  it('remembers the chosen color, and starts on Day', () => {
    expect(savedColor()).toBe('day')
    saveColor('paper')
    expect(savedColor()).toBe('paper')
  })
  it('says how many pages are left in the chapter', () => {
    expect(chapterLeft(0, 5)).toBe('4 pages left in this chapter')
    expect(chapterLeft(3, 5)).toBe('1 page left in this chapter')
    expect(chapterLeft(4, 5)).toBe('Last page of this chapter')
  })
})
