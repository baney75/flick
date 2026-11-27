// Escape closes what is open, newest first, and stops there: the app's Back handler (spatial.ts) and a
// page's own keys never see it. With nothing open, the app's Back handler goes back as before.

import { useLayoutEffect, useRef } from 'preact/hooks'

type Entry = { close: () => void; page: boolean }
const open: Entry[] = []
let listening = false

const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('input:not([type="checkbox"]):not([type="range"]), textarea, select')

function onKey(e: KeyboardEvent) {
  const top = open.at(-1)
  if (e.key !== 'Escape' || !top || (top.page && typing(e.target))) return
  e.preventDefault()
  e.stopPropagation()
  top.close()
}

/**
 * While `on`, Escape calls `close` instead of going back. A menu, sheet or panel passes whether it is
 * open. A page that leaves on Escape itself (a reader) passes `page`: it is the bottom of the stack, and
 * Escape in a text field there does nothing, as on any other page.
 *
 * The listener is on the document in the capture phase, so a sheet that handles its own keys on the
 * window first (Titles, Photos, Extensions) still does.
 */
export function useEscape(on: boolean, close: () => void, page = false) {
  const latest = useRef(close)
  latest.current = close
  // A layout effect: the entry is on the stack as soon as the menu shows, and off it as soon as the menu or
  // its page is gone. A plain effect runs after the next paint, and an Escape before then went to the
  // wrong entry.
  useLayoutEffect(() => {
    if (!on) return
    if (!listening) { listening = true; document.addEventListener('keydown', onKey, true) }
    const entry: Entry = { close: () => latest.current(), page }
    open.push(entry)
    return () => {
      const i = open.indexOf(entry)
      if (i >= 0) open.splice(i, 1)
    }
  }, [on, page])
}
