// Tab and Shift+Tab stay inside an open sheet. A modal sheet that let focus walk onto the page behind it
// left the keyboard on controls the sheet covers.

import { useLayoutEffect } from 'preact/hooks'
import type { RefObject } from 'preact'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** While `box` is on the page, Tab moves through its own controls only, wrapping at either end. */
export function useFocusTrap(box: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = box.current
      if (e.key !== 'Tab' || !el) return
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0)
      if (!f.length) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      f[i < 0 ? (e.shiftKey ? f.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus()
    }
    document.addEventListener('keydown', k, true)
    return () => document.removeEventListener('keydown', k, true)
  }, [])
}
