// Runs inside the page before the app (scripts/perf.mjs adds it as an init script). It times
// interactions from the input event to the frame that shows the result, and measures layout shift.
// Kept plain browser JavaScript, no imports: Playwright injects it as text.
(() => {
  if (window.__perf) return
  const P = (window.__perf = {})
  const now = () => performance.now()
  const scroller = () => document.querySelector('.main')
  // A frame has been presented once a task posted from its requestAnimationFrame runs.
  const afterPaint = (cb) => requestAnimationFrame(() => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => cb(now())
    ch.port2.postMessage(0)
  })
  const matches = (m) => {
    if (!m) return true
    for (const el of document.querySelectorAll(m.sel)) if (!m.text || (el.textContent || '').trim().startsWith(m.text)) return true
    return false
  }

  // ---- cold start: from navigation to the first frame showing a marker, and to a quiet DOM ----
  const boot = (P.boot = { marks: {}, lastMut: 0, lastPaint: 0, gaps: [] })
  const want = { home: { sel: '.main .row-section' }, welcome: { sel: '.main .welcome' } }
  const bootMo = new MutationObserver(() => {
    boot.lastMut = now()
    afterPaint((t) => { boot.lastPaint = t })
  })
  bootMo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  let prev = 0
  const bootFrame = (t) => {
    if (prev) boot.gaps.push(t - prev)
    prev = t
    for (const [k, m] of Object.entries(want)) if (!boot.marks[k] && document.body && matches(m)) afterPaint((at) => { boot.marks[k] ??= at })
    if (now() < 20000 && !P.bootDone) requestAnimationFrame(bootFrame)
  }
  requestAnimationFrame(bootFrame)
  // When the library's own rows first paint (Home's Recently added), watched past the first tap: the
  // items can land after Home is usable.
  const itemsFrame = () => {
    if (boot.marks.items || now() > 30000) return
    for (const h of document.querySelectorAll('.main .row-section .row-head h2')) if (h.textContent === 'Recently added') { afterPaint((at) => { boot.marks.items ??= at }); return }
    requestAnimationFrame(itemsFrame)
  }
  requestAnimationFrame(itemsFrame)
  /** Resolves as soon as Home has painted (or the welcome screen, for an empty library). */
  P.homePainted = (timeout = 15000) => new Promise((ok) => {
    const t0 = now()
    const tick = () => {
      if (!boot.marks.home && now() - t0 <= timeout) return setTimeout(tick, 5)
      // The boot watchers stop here, so they add no work to the steps timed next.
      P.bootDone = true
      bootMo.disconnect()
      ok({ painted: boot.marks.home ?? null, welcome: boot.marks.welcome ?? null })
    }
    tick()
  })
  /** Resolves once Home has painted and the DOM has been quiet for `quiet` ms. */
  P.booted = (quiet = 100, timeout = 15000) => new Promise((ok) => {
    const t0 = now()
    const tick = () => {
      const settled = boot.marks.home && now() - boot.lastMut >= quiet && boot.lastPaint >= boot.lastMut
      if (settled || now() - t0 > timeout) {
        P.bootDone = true
        bootMo.disconnect()
        const longest = Math.max(0, ...boot.gaps)
        ok({ painted: boot.marks.home ?? null, interactive: settled ? Math.max(boot.marks.home, boot.lastPaint) : null, welcome: boot.marks.welcome ?? null, longestFrame: longest })
      } else setTimeout(tick, 20)
    }
    tick()
  })

  // ---- one interaction: arm, act through Playwright, then read the result ----
  P.arm = (opts = {}) => {
    const cur = (P.cur = { t0: null, painted: null, last: null, lastMut: 0, muts: 0, maxGap: 0, marker: opts.marker ?? null })
    const types = opts.events ?? ['click', 'keydown']
    const onEv = (e) => {
      if (cur.t0 != null) return
      const n = now()
      // The event's own time, however late the handler runs: that wait is what a busy page costs.
      cur.t0 = e.timeStamp > 0 && e.timeStamp <= n ? e.timeStamp : n
      frame()
    }
    for (const t of types) addEventListener(t, onEv, true)
    const onHash = () => { cur.hash ??= now() }
    addEventListener('hashchange', onHash)
    cur.mo = new MutationObserver(() => {
      if (cur.t0 == null) return
      cur.muts++
      cur.lastMut = now()
      afterPaint((t) => { cur.last = t })
    })
    cur.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    let last = 0
    const frame = () => requestAnimationFrame((t) => {
      if (last) cur.maxGap = Math.max(cur.maxGap, t - last)
      last = t
      // With a marker, the frame that shows it; without one, the first frame after the input.
      if (cur.painted == null && (cur.marker ? cur.muts > 0 && matches(cur.marker) : true)) afterPaint((at) => { cur.painted ??= at })
      if (!cur.done) frame()
    })
    cur.off = () => { removeEventListener('hashchange', onHash); for (const t of types) removeEventListener(t, onEv, true); cur.mo.disconnect(); cur.done = true }
  }
  /** Arms with t0 = now and goes to a route, for a screen reached without a tap. */
  P.go = (path, marker) => {
    P.arm({ events: [], marker })
    P.cur.t0 = now()
    location.hash = path
    requestAnimationFrame(function f() { if (P.cur.painted == null && P.cur.muts > 0 && matches(P.cur.marker)) afterPaint((at) => { P.cur.painted ??= at }); if (!P.cur.done) requestAnimationFrame(f) })
  }
  P.result = (quiet = 100, timeout = 5000) => new Promise((ok) => {
    const cur = P.cur, start = now()
    const tick = () => {
      const quietNow = cur.t0 != null && cur.painted != null && now() - Math.max(cur.lastMut, cur.painted) >= quiet && (cur.muts === 0 || (cur.last ?? 0) >= cur.lastMut)
      if (quietNow || now() - start > timeout) {
        cur.off()
        const t0 = cur.t0
        ok({
          painted: t0 != null && cur.painted != null ? cur.painted - t0 : null,
          at: cur.painted,
          settled: t0 != null && cur.painted != null ? Math.max(cur.painted, cur.last ?? 0) - t0 : null,
          hash: cur.hash != null && t0 != null ? cur.hash - t0 : undefined,
          muts: cur.muts, maxGap: cur.maxGap, timedOut: !quietNow,
        })
      } else setTimeout(tick, 10)
    }
    tick()
  })

  // ---- scroll fling: the main pane from top to bottom, one step a frame ----
  P.fling = (minStep = 200, frames = 300) => new Promise((ok) => {
    const el = scroller()
    el.scrollTop = 0
    const max = el.scrollHeight - el.clientHeight
    const step = Math.max(minStep, max / frames)
    const gaps = []
    const longTasks = []
    let po = null
    // A smooth-scroll style would turn each step into an animation; a fling sets the position itself.
    const behavior = el.style.scrollBehavior
    el.style.scrollBehavior = 'auto'
    if ((PerformanceObserver.supportedEntryTypes || []).includes('longtask')) try {
      po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration) })
      po.observe({ type: 'longtask' })
    } catch { po = null }
    let last = 0
    requestAnimationFrame(function f(t) {
      if (last) gaps.push(t - last)
      last = t
      if (el.scrollTop < max - 1 && gaps.length < frames * 3) {
        el.scrollTop = Math.min(max, el.scrollTop + step)
        requestAnimationFrame(f)
        return
      }
      setTimeout(() => {
        po?.disconnect()
        el.style.scrollBehavior = behavior
        const vsync = 1000 / 60
        // A gap of k frames dropped k-1 frames. Under 1.5 frames is jitter, not a drop.
        const dropped = gaps.reduce((n, g) => n + (g > vsync * 1.5 ? Math.round(g / vsync) - 1 : 0), 0)
        const expected = gaps.reduce((n, g) => n + Math.max(1, Math.round(g / vsync)), 0)
        const longest = longTasks.length ? Math.max(...longTasks) : Math.max(0, ...gaps.map((g) => g - vsync))
        ok({ frames: gaps.length, dropped, droppedPct: expected ? (dropped / expected) * 100 : 0, longest, longTaskApi: !!po, height: max, step })
      }, 50)
    })
  })

  // ---- layout shift: things on screen in one frame that move or resize in the next ----
  // Each thing is known by what it shows (a card by its title), not by its DOM node: the virtual grid
  // reuses nodes for other cards as it scrolls, which moves no content. Positions are in the page's
  // own coordinates (viewport top plus the main pane's scroll), so scrolling itself is no shift.
  // Moved areas are unioned on a 10 px grid, as CLS does, so a container and the cards in it that move
  // together count once.
  const TRACK = '.main .card, .main .page-head, .main .toolbar, .main .list-row, .main .shelf-row, .main .row-head, .main .detail-head, .main .hub-group > h4, .main .status, .main .empty, .main .welcome'
  const CELL = 10
  P.clsStart = () => {
    const st = (P.cls = { score: 0, prev: new Map(), resizes: 0, on: true, shifts: [], t0: now(), screen: document.querySelector('.main')?.lastElementChild })
    const vw = innerWidth, vh = innerHeight, area = vw * vh
    const tick = () => {
      if (!st.on) return
      const next = new Map()
      const seen = new Map()
      const hit = new Set()
      let dist = 0
      // A new screen is not a shift: CLS counts only content that stays on screen and moves. Each screen is
      // the last child of the main pane, a new element when the view changes.
      const screen = document.querySelector('.main')?.lastElementChild
      const fresh = screen !== st.screen
      st.screen = screen
      for (const el of document.querySelectorAll(TRACK)) {
        // Count every copy of a title, on screen or not, so the nth copy stays the nth as others scroll away.
        const what = `${el.className.split(' ')[0]}|${el.getAttribute('title') ?? (el.textContent || '').slice(0, 40)}`
        const k = `${what}|${seen.get(what) ?? 0}`
        seen.set(what, (seen.get(what) ?? 0) + 1)
        const r = el.getBoundingClientRect()
        if (r.bottom < 0 || r.top > vh || r.width === 0) continue
        let sx = 0, sy = 0
        for (let a = el.parentElement; a; a = a.parentElement) { sx += a.scrollLeft; sy += a.scrollTop }
        const p = [r.left + sx, r.top + sy, r.width, r.height]
        next.set(k, p)
        const q = fresh ? undefined : st.prev.get(k)
        if (!q) continue
        const dx = Math.abs(p[0] - q[0]), dy = Math.abs(p[1] - q[1]), dw = Math.abs(p[2] - q[2]), dh = Math.abs(p[3] - q[3])
        if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
          for (let cy = Math.max(0, Math.floor(r.top / CELL)); cy < Math.min(vh, r.bottom) / CELL; cy++)
            for (let cx = Math.max(0, Math.floor(r.left / CELL)); cx < Math.min(vw, r.right) / CELL; cx++) hit.add(cy * 10000 + cx)
          dist = Math.max(dist, dx, dy, dw, dh)
          if (el.classList.contains('card') && (dw > 1 || dh > 1)) st.resizes++
          st.shifts.push(`${Math.round(now() - st.t0)}ms ${k.slice(0, 50)} moved ${Math.round(dx)},${Math.round(dy)} resized ${Math.round(dw)},${Math.round(dh)}`)
        }
      }
      if (hit.size) st.score += Math.min(1, (hit.size * CELL * CELL) / area) * Math.min(1, dist / Math.max(vw, vh))
      st.prev = next
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  P.clsStop = () => { const st = P.cls; st.on = false; return { score: st.score, resizes: st.resizes, shifts: st.shifts.slice(0, 12) } }
})()
