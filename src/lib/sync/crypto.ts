// A sync group is one random 32-byte secret. Devices that hold it can read and write the
// group's data; the relay sees only a room id derived from it and sealed bytes.
// The secret travels only in a pairing link's #fragment or QR code, never to a server.

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function newSecret(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)))
}

export interface Group { secret: string; room: string; key: CryptoKey }

export async function openGroup(secret: string): Promise<Group> {
  const raw = unb64u(secret)
  if (raw.length !== 32) throw new Error('That pairing code is not complete.')
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) })
  const roomBits = await crypto.subtle.deriveBits(hkdf('flick-sync-room-v1'), base, 128)
  const key = await crypto.subtle.deriveKey(hkdf('flick-sync-data-v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const room = [...new Uint8Array(roomBits)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { secret, room, key }
}

export async function seal(key: CryptoKey, msg: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(msg))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return b64u(out)
}

// Throws on anything not sealed with this group's key, so a relay or stranger cannot inject messages.
export async function unseal<T = unknown>(key: CryptoKey, sealed: string): Promise<T> {
  const raw = unb64u(sealed)
  if (raw.length < 29) throw new Error('Message too short.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))
  return JSON.parse(dec.decode(pt)) as T
}

// Pairing links: https://flick-player.pages.dev/#/pair?k=<secret>. Also accepts flick://pair?k=
// and a bare code pasted by hand.
export function pairLink(secret: string, base = 'https://flick-player.pages.dev/'): string {
  return `${base}#/pair?k=${secret}`
}

export function parsePair(text: string): string | null {
  const s = text.trim()
  const m = s.match(/[?&#]k=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/)
  if (m) return m[1]
  return /^[A-Za-z0-9_-]{43}$/.test(s) ? s : null
}
