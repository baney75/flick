import { describe, expect, it } from 'vitest'
import { clampPage, itemKindOf, kindOf, parseBook } from '../src/lib/parse'

describe('books', () => {
  it('treats PDFs as books, never as something to play', () => {
    expect(itemKindOf('Dune.pdf')).toBe('book')
    expect(itemKindOf('Dune.PDF')).toBe('book')
    expect(kindOf('Dune.pdf')).toBeNull()
    expect(itemKindOf('movie.mkv')).toBe('video')
    expect(itemKindOf('notes.txt')).toBeNull()
  })

  it('reads author, title and year from the file name', () => {
    expect(parseBook('Frank Herbert - Dune (1965).pdf')).toEqual({ title: 'Dune', author: 'Frank Herbert', year: 1965 })
    expect(parseBook('The_Hobbit.pdf')).toEqual({ title: 'The Hobbit', author: undefined, year: undefined })
    expect(parseBook('C. S. Lewis - Mere Christianity - Annotated [1952].pdf'))
      .toEqual({ title: 'Mere Christianity - Annotated', author: 'C. S. Lewis', year: 1952 })
  })

  it('keeps page numbers inside the book', () => {
    expect(clampPage(0, 10)).toBe(1)
    expect(clampPage(11, 10)).toBe(10)
    expect(clampPage(Number.NaN, 10)).toBe(1)
    expect(clampPage(3.6, 10)).toBe(4)
    expect(clampPage(5, 0)).toBe(1)
  })
})
