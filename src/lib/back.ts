// Back within Flick. The browser's history can hold pages from before Flick (a new tab page, another
// site), so `history.length` cannot say whether Flick has a page to go back to. Each entry Flick makes
// is numbered in `history.state` instead: 0 is the page Flick opened on.

let depth = 0
let replacing = false
const numbered = () => (typeof history.state?.flickDepth === 'number' ? (history.state.flickDepth as number) : null)

/** Numbers this entry and every new one. Called once at start; a reload keeps the numbers. */
export function trackHistory() {
  const d = numbered()
  if (d === null) history.replaceState({ ...history.state, flickDepth: 0 }, '')
  else depth = d
  addEventListener('hashchange', () => {
    const at = numbered()
    if (at !== null) depth = at
    else {
      if (!replacing) depth++
      history.replaceState({ ...history.state, flickDepth: depth }, '')
    }
    replacing = false
  })
}

/** Back one page, or Home in place of this page when Flick has none before it (a link or a new window opened it). */
export function back() {
  if (depth > 0) history.back()
  else if (location.hash !== '#/') {
    replacing = true
    location.replace('#/')
  }
}
