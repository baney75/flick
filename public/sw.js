// App-shell cache so Flick opens instantly and works offline. Media is never cached here.
const CACHE = 'flick-v1'
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/index.html', '/icon.svg', '/manifest.webmanifest'])))
  self.skipWaiting()
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
  self.clients.claim()
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (e.request.headers.has('range')) return
  if (url.pathname === '/plugin-host.html' || url.pathname === '/plugin-host.js') {
    // The plugin sandbox page: network first, cached for offline, never stored as the app shell.
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); return r }).catch(() => caches.match(url.pathname)))
    return
  }
  if (e.request.mode === 'navigate' && e.request.destination === 'document') {
    // Network first for the page, so updates land; cache when offline.
    e.respondWith(fetch(e.request).then((r) => { caches.open(CACHE).then((c) => c.put('/', r.clone())); return r }).catch(() => caches.match('/')))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    // Hashed build files never change: cache first.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r })))
  }
})
