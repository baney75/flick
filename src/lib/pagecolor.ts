// The reader's page color: Day, Paper (sepia) or Night, shared by the PDF and EPUB readers.

import type { PageColor } from './epub'

export const PAGE_COLORS: { id: PageColor; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'paper', label: 'Paper' },
  { id: 'night', label: 'Night' },
]

/** The saved page color. Older versions saved only Night on or off. */
export function savedColor(): PageColor {
  try {
    const c = localStorage.getItem('flick.reader.color')
    if (c === 'day' || c === 'paper' || c === 'night') return c
    return localStorage.getItem('flick.reader.night') === '1' ? 'night' : 'day'
  } catch { return 'day' }
}

export function saveColor(c: PageColor) {
  try { localStorage.setItem('flick.reader.color', c) } catch { /* private mode */ }
}

/** "4 pages left in this chapter", or "Last page of this chapter". */
export function chapterLeft(page: number, pages: number): string {
  const left = pages - page - 1
  return left <= 0 ? 'Last page of this chapter' : `${left} page${left === 1 ? '' : 's'} left in this chapter`
}
