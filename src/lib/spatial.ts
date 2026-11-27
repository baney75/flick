// Arrow-key navigation between controls, for TV remotes (D-pad) and keyboard users.
// The player handles its own keys; this covers every other screen.

import { back, trackHistory } from './back'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]), select, [tabindex]:not([tabindex="-1"])'

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && r.bottom > -200 && r.top < innerHeight + 200
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export function move(dir: 'up' | 'down' | 'left' | 'right', from: HTMLElement | null): HTMLElement | null {
  const els = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e !== from && visible(e))
  if (!from || from === document.body) return (document.querySelector<HTMLElement>('.main .card, .main button, .nav-item.on')) ?? els[0] ?? null
  const a = from.getBoundingClientRect()
  const ca = center(a)
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of els) {
    const b = el.getBoundingClientRect()
    const cb = center(b)
    const dx = cb.x - ca.x
    const dy = cb.y - ca.y
    let main: number, cross: number
    if (dir === 'right') { if (b.left < a.right - 4) continue; main = b.left - a.right; cross = Math.abs(dy) }
    else if (dir === 'left') { if (b.right > a.left + 4) continue; main = a.left - b.right; cross = Math.abs(dy) }
    else if (dir === 'down') { if (b.top < a.bottom - 4) continue; main = b.top - a.bottom; cross = Math.abs(dx) }
    else { if (b.bottom > a.top + 4) continue; main = a.top - b.bottom; cross = Math.abs(dx) }
    // Stay in the same row or column when possible.
    const score = main + cross * 2.2
    if (score < bestScore) { bestScore = score; best = el }
  }
  return best
}

export function installSpatialNav(isPlayerOpen: () => boolean) {
  trackHistory()
  const isTv = /Android TV|GoogleTV|AFT[A-Z]|BRAVIA|SMART-TV|Tizen|WebOS/i.test(navigator.userAgent) || matchMedia('(pointer: none)').matches
  if (isTv) document.documentElement.classList.add('tv')
  addEventListener('keydown', (e) => {
    if (isPlayerOpen() || e.metaKey || e.ctrlKey || e.altKey) return
    const active = document.activeElement as HTMLElement | null
    const typing = active?.matches('input:not([type="checkbox"]):not([type="range"]), textarea, select')
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    const dir = dirs[e.key]
    if (dir) {
      if (typing && (dir === 'left' || dir === 'right')) return
      const next = move(dir, active)
      if (next) {
        e.preventDefault()
        next.focus({ preventScroll: true })
        next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
      }
      return
    }
    // Remote "Back" button.
    if ((e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Escape' && !typing)) && location.hash.length > 2) {
      e.preventDefault()
      back()
    }
  })
}
