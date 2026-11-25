// The synced state: a map of last-writer-wins entries that any two devices can merge
// in either order and end up equal. A deleted value is kept as a null tombstone so the
// delete travels to devices that were offline.

export interface Entry { v: unknown; t: number; d: string }
export type Doc = Map<string, Entry>
export type DigestRow = [key: string, t: number, d: string]

// Newer time wins; a tie goes to the larger device id so every device picks the same one.
export function wins(a: Entry, b: Entry | undefined): boolean {
  return !b || a.t > b.t || (a.t === b.t && a.d > b.d)
}

// Wall time that never runs backwards and stays ahead of anything already seen,
// so a write always beats the value it replaces even when device clocks disagree a little.
export class Clock {
  last = 0
  now(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }
  see(t: number) {
    // A device with a clock far in the future must not drag every later write with it.
    const cap = Date.now() + 60_000
    if (t > this.last) this.last = Math.min(t, cap)
  }
}

// A local write always beats the value it replaces, even one stamped by a device whose
// clock ran far ahead: it takes a time just past that entry's.
export function write(doc: Doc, clock: Clock, device: string, key: string, v: unknown): Entry {
  const prev = doc.get(key)
  const e = { v: v === undefined ? null : v, t: Math.max(clock.now(), (prev?.t ?? 0) + 1), d: device }
  doc.set(key, e)
  return e
}

export function digest(doc: Doc): DigestRow[] {
  return [...doc].map(([k, e]) => [k, e.t, e.d])
}

// Everything the peer lacks or holds an older copy of.
export function missingFor(doc: Doc, peer: DigestRow[]): [string, Entry][] {
  const theirs = new Map(peer.map(([k, t, d]) => [k, { v: null, t, d }]))
  return [...doc].filter(([k, e]) => wins(e, theirs.get(k)))
}

// Apply entries from a peer. Returns the keys whose value changed here.
export function merge(doc: Doc, clock: Clock, incoming: [string, Entry][]): string[] {
  const changed: string[] = []
  for (const [k, e] of incoming) {
    if (!valid(e)) continue
    clock.see(e.t)
    if (wins(e, doc.get(k))) {
      doc.set(k, { v: e.v, t: e.t, d: e.d })
      changed.push(k)
    }
  }
  return changed
}

function valid(e: Entry): boolean {
  return !!e && Number.isSafeInteger(e.t) && e.t > 0 && e.t < Number.MAX_SAFE_INTEGER && typeof e.d === 'string' && e.d.length > 0 && e.d.length <= 64
}
