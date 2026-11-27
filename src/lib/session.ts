// This session's small UI memory (the Library chip, a plugin's last catalog), read from memory.
//
// WebKit, the webview Flick runs in on macOS and iOS, loads a page's sessionStorage with a synchronous
// call out of the page the first time anything touches it. Once plugin frames and thumbnails are
// loading, that call waited 1.6 s on an idle machine and up to 20 s under load, and Library's first
// open sat on it (`npm run perf`, nav.home-library). Here it happens once, when this module loads at
// boot, while nothing else is loading; every read after that comes from the copy below.

const copy = new Map<string, string>()
try {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k != null) copy.set(k, sessionStorage.getItem(k) ?? '')
  }
} catch { /* private mode, or no storage: the copy alone keeps this session's picks */ }

export function sessionGet(key: string): string | null {
  return copy.get(key) ?? null
}

/** Saves for this session, and to sessionStorage so a reload keeps it. */
export function sessionSet(key: string, value: string) {
  copy.set(key, value)
  try { sessionStorage.setItem(key, value) } catch { /* private mode */ }
}
