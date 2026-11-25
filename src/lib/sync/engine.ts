// Runs one sync group on this device: keeps the doc in IndexedDB, talks to the group's
// other devices through the relay, and swaps digests so each side sends only what the
// other lacks. Every message is sealed with the group key before it leaves the device.

import { signal } from '@preact/signals'
import * as db from '../db'
import { Clock, digest, merge, missingFor, write, type Doc, type DigestRow, type Entry } from './doc'
import { newSecret, openGroup, seal, unseal, type Group } from './crypto'

const DEFAULT_RELAY = 'wss://flick-sync.magnus-b37.workers.dev'
// Tests and self-hosters point Flick at another relay with localStorage 'flick.relay'.
function relay(): string {
  try { return localStorage.getItem('flick.relay') || DEFAULT_RELAY } catch { return DEFAULT_RELAY }
}

export interface Peer { id: string; name: string; seen: number; online: boolean }
export interface SyncState { paired: boolean; secret: string | null; device: string; name: string; status: 'off' | 'connecting' | 'online' | 'offline'; peers: Peer[] }

type Msg =
  | { type: 'hello'; from: string; name: string }
  | { type: 'welcome'; from: string; name: string; to: string; rows: DigestRow[] }
  | { type: 'digest'; from: string; to: string; rows: DigestRow[] }
  | { type: 'entries'; from: string; to?: string; list: [string, Entry][] }
  | { type: 'bye'; from: string }
  | { type: 'beat'; from: string }

interface Saved { secret: string | null; device: string; name: string; peers: Peer[] }

export const sync = signal<SyncState>({ paired: false, secret: null, device: '', name: '', status: 'off', peers: [] })

const doc: Doc = new Map()
const clock = new Clock()
let group: Group | null = null
let ws: WebSocket | null = null
let connecting = false
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
// Each device sends a sealed heartbeat every 30 seconds. Peers count as online only while they have
// been heard from in the last 75 seconds, so a device that vanished (asleep, offline, tab killed) stops
// showing as online. The heartbeat also keeps the relay from giving a full room's place away; it drops
// devices silent for 90 seconds. Background tabs still fire this about once a minute.
const BEAT_MS = 30_000
const FRESH_MS = 75_000
let beatTimer: ReturnType<typeof setInterval> | undefined
// Sealed once per connection, so closing the page can still say goodbye synchronously.
let byeSealed: string | null = null
// Other tabs of this browser share the stored membership; tell them when it changes.
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('flick-sync') : null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let onChange: (keys: string[]) => void = () => {}

export function guessName(ua = navigator.userAgent): string {
  if (/Android/i.test(ua) && /TV|AFT|BRAVIA|SHIELD/i.test(ua)) return 'Android TV'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'Device'
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The stored record is the truth about which group this browser is in. Only join and leave change the
// secret; anything else that saves first checks it, so a tab left behind by another tab's join or leave
// adopts the new membership instead of writing its old group back.
async function persist(membership = false) {
  if (!membership) {
    const stored = await db.get<Saved>('kv', 'sync')
    if (stored && stored.secret !== sync.value.secret) return adopt(stored)
  }
  const s = sync.value
  await db.put('kv', 'sync', { secret: s.secret, device: s.device, name: s.name, peers: s.peers.map((p) => ({ ...p, online: false })) } satisfies Saved)
  if (membership) tabs?.postMessage('membership')
}

// Take on membership another tab stored: drop this tab's connection and doc, then join what is stored.
async function adopt(stored: Saved) {
  retire()
  doc.clear()
  const rows = (await db.get<[string, Entry][]>('kv', 'sync.doc')) ?? []
  for (const [k, e] of rows) { doc.set(k, e); clock.see(e.t) }
  sync.value = { ...sync.value, paired: !!stored.secret, secret: stored.secret, status: 'off', peers: stored.peers ?? [] }
  if (stored.secret) await connect()
}

// Save within 800 ms of the first unsaved change, however busy sync is, and right away
// when the page is hidden, so a reload never loses entries.
function saveDocNow() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  return db.put('kv', 'sync.doc', [...doc]).catch(() => {})
}
function saveDocSoon() {
  if (saveTimer === undefined) saveTimer = setTimeout(saveDocNow, 800)
}

// Load saved state and connect when this device is in a group.
export async function startSync(handler: (keys: string[]) => void) {
  onChange = handler
  const saved = await db.get<Saved>('kv', 'sync')
  const rows = (await db.get<[string, Entry][]>('kv', 'sync.doc')) ?? []
  for (const [k, e] of rows) { doc.set(k, e); clock.see(e.t) }
  sync.value = {
    paired: !!saved?.secret, secret: saved?.secret ?? null, device: saved?.device || randomId(),
    name: saved?.name || guessName(), status: 'off', peers: saved?.peers ?? [],
  }
  if (!saved) await persist(true)
  if (sync.value.secret) await connect()
  addEventListener('online', () => { if (sync.value.secret && !ws) connect() })
  addEventListener('pagehide', () => {
    if (saveTimer !== undefined) saveDocNow()
    if (ws?.readyState === WebSocket.OPEN && byeSealed) ws.send(byeSealed)
  })
  tabs?.addEventListener('message', async () => {
    const stored = await db.get<Saved>('kv', 'sync')
    if (stored && stored.secret !== sync.value.secret) await adopt(stored)
  })
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer !== undefined) saveDocNow() })
}

export const docValue = (key: string) => doc.get(key)?.v
export const docKeys = (prefix: string) => [...doc.keys()].filter((k) => k.startsWith(prefix))

// Record local changes and send them to every connected device.
export function publish(changes: [key: string, value: unknown][]) {
  if (!changes.length) return
  const list = changes.map(([k, v]) => [k, write(doc, clock, sync.value.device, k, v)] as [string, Entry])
  saveDocSoon()
  send({ type: 'entries', from: sync.value.device, list })
}

// Offer keys this device has and the doc does not. Seeded entries carry time 1, so any
// value a peer ever wrote beats them, and a device rejoining never overwrites the group.
export function seed(changes: [string, unknown][]) {
  const list = changes.filter(([k]) => !doc.has(k)).map(([k, v]) => {
    const e: Entry = { v: v === undefined ? null : v, t: 1, d: sync.value.device }
    doc.set(k, e)
    return [k, e] as [string, Entry]
  })
  if (!list.length) return
  saveDocSoon()
  send({ type: 'entries', from: sync.value.device, list })
}

export async function createGroup() { await join(newSecret()) }

// Joining a different group starts clean: the old group's entries and devices stay behind, so
// nothing from it reaches the new one. Rejoining the same group keeps them.
export async function join(secret: string) {
  if (secret === sync.value.secret) return connect()
  await leave()
  sync.value = { ...sync.value, paired: true, secret }
  await persist(true)
  await connect()
}

export async function leave() {
  // Say goodbye before closing, so the other devices show this one offline at once.
  const g = group, sock = ws
  if (g && sock?.readyState === WebSocket.OPEN) {
    await seal(g.key, { type: 'bye', from: sync.value.device } satisfies Msg).then((m) => sock.send(m)).catch(() => {})
  }
  retire()
  doc.clear()
  await db.del('kv', 'sync.doc')
  sync.value = { ...sync.value, paired: false, secret: null, status: 'off', peers: [] }
  await persist(true)
}

// Close the connection and stop every timer. A retired socket can no longer change state or deliver messages.
function retire() {
  const sock = ws
  ws = null
  group = null
  byeSealed = null
  clearTimeout(retryTimer)
  clearInterval(beatTimer)
  if (sock) { sock.onopen = sock.onmessage = sock.onclose = null; try { sock.close() } catch { /* already closed */ } }
}

export async function rename(name: string) {
  sync.value = { ...sync.value, name: name.trim().slice(0, 40) || guessName() }
  await persist()
  send({ type: 'hello', from: sync.value.device, name: sync.value.name })
}

// The one way to open a connection: the network coming back, a retry and a join all land here, and
// whatever connection came before is retired first, so a device never holds two sockets.
async function connect() {
  const secret = sync.value.secret
  if (!secret || connecting) return
  connecting = true
  try {
    retire()
    const g = await openGroup(secret)
    if (sync.value.secret !== secret) return // left or switched while the key was derived
    group = g
    sync.value = { ...sync.value, status: 'connecting' }
    const sock = new WebSocket(`${relay()}/room/${g.room}`)
    ws = sock
    sock.onopen = async () => {
      retry = 0
      byeSealed = await seal(g.key, { type: 'bye', from: sync.value.device } satisfies Msg).catch(() => null)
      if (ws !== sock) return
      beatTimer = setInterval(beat, BEAT_MS)
      sync.value = { ...sync.value, status: 'online' }
      send({ type: 'hello', from: sync.value.device, name: sync.value.name })
    }
    sock.onmessage = async (e) => {
      if (e.data === 'pong') return
      let m: Msg
      try { m = await unseal<Msg>(g.key, String(e.data)) } catch { return } // not from this group
      if (ws !== sock) return // retired while it was being opened
      if (m.from === sync.value.device) return
      if ('to' in m && m.to && m.to !== sync.value.device) return
      receive(m)
    }
    sock.onclose = () => {
      if (ws !== sock) return
      retire()
      sync.value = { ...sync.value, status: 'offline', peers: sync.value.peers.map((p) => ({ ...p, online: false })) }
      retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
    }
  } finally {
    connecting = false
  }
}

// Tell the group this device is here, and stop showing devices not heard from lately.
function beat() {
  send({ type: 'beat', from: sync.value.device })
  const now = Date.now()
  if (sync.value.peers.some((p) => p.online && now - p.seen > FRESH_MS)) {
    sync.value = { ...sync.value, peers: sync.value.peers.map((p) => (p.online && now - p.seen > FRESH_MS ? { ...p, online: false } : p)) }
  }
}

function seePeer(id: string, name: string | undefined, online: boolean) {
  const peers = sync.value.peers.filter((p) => p.id !== id)
  const old = sync.value.peers.find((p) => p.id === id)
  peers.push({ id, name: name ?? old?.name ?? 'Device', seen: Date.now(), online })
  sync.value = { ...sync.value, peers }
  persist().catch(() => {})
}

function receive(m: Msg) {
  const me = sync.value.device
  switch (m.type) {
    case 'hello':
      seePeer(m.from, m.name, true)
      send({ type: 'welcome', from: me, name: sync.value.name, to: m.from, rows: digest(doc) })
      break
    case 'welcome':
      seePeer(m.from, m.name, true)
      send({ type: 'digest', from: me, to: m.from, rows: digest(doc) })
      sendEntries(m.from, missingFor(doc, m.rows))
      break
    case 'digest':
      sendEntries(m.from, missingFor(doc, m.rows))
      break
    case 'entries': {
      const changed = merge(doc, clock, m.list)
      if (changed.length) { saveDocSoon(); onChange(changed) }
      break
    }
    case 'bye':
      seePeer(m.from, undefined, false)
      break
    case 'beat': {
      // A beat from a device this one has not met (it joined while this one was away) gets a hello back.
      const known = sync.value.peers.find((p) => p.id === m.from)
      seePeer(m.from, undefined, true)
      if (!known?.online) send({ type: 'hello', from: me, name: sync.value.name })
      break
    }
  }
}

// The relay caps a message at 256 KiB; sealed text is about 4/3 the JSON size.
function sendEntries(to: string, list: [string, Entry][]) {
  let chunk: [string, Entry][] = []
  let size = 0
  for (const row of list) {
    const n = JSON.stringify(row).length
    if (size + n > 150_000 && chunk.length) { send({ type: 'entries', from: sync.value.device, to, list: chunk }); chunk = []; size = 0 }
    chunk.push(row)
    size += n
  }
  if (chunk.length) send({ type: 'entries', from: sync.value.device, to, list: chunk })
}

function send(m: Msg) {
  const g = group, sock = ws
  if (!g || !sock || sock.readyState !== WebSocket.OPEN) return
  seal(g.key, m).then((s) => { if (sock.readyState === WebSocket.OPEN) sock.send(s) }).catch(() => {})
}
